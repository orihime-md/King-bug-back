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
const VERSION = '3.11.2';
const STARTTIME = Date.now();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const OWNER_NUMBER = '2348161796121';
const OWNER_JID = `${OWNER_NUMBER}@s.whatsapp.net`;
const PREFIX = '.';
const AUTH_DIR = path.join(__dirname, 'auth');

// NOTE: The supplied 3.11.2 source also contains an oversized invisible-text
// payload and incomplete .vid-crash/.bomb-gc/.bug-gc command code marked as
// truncated/placeholders. Those fragments are not a reliable implementation
// and are not copied into this production merge. Existing first-file command
// handlers remain intact, so no existing command path is removed.

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
    proto,
    downloadContentFromMessage,
    WAMessageStubType
} = await import('@whiskeysockets/baileys');

let botMode = 'public';

const logger = pino({ level: 'silent' });
// Baileys 6.x builds do not consistently expose makeInMemoryStore.
// Keep the same message-store functionality locally so getMessage and
// event binding continue to work without depending on that export.
const messageStore = new Map();
const lidToPn = new Map();

// Group state is kept per WhatsApp group JID. It intentionally does not use
// the current chat as a hidden target: commands that receive a group JID act
// only on that exact group.
const groupSettings = new Map();
const groupMetadataCache = new Map();
const groupMetadataCacheTtlMs = 5 * 60 * 1000;

// Baileys uses this cache when asking for message retries. Keeping it outside
// the socket means a reconnect does not reset retry counters.
const msgRetryCounterCache = {
    _items: new Map(),
    _ttlMs: 10 * 60 * 1000,
    _key(key) { return String(key || ''); },
    get(key) {
        const k = this._key(key);
        const item = this._items.get(k);
        if (!item) return undefined;
        if (Date.now() - item.ts > this._ttlMs) {
            this._items.delete(k);
            return undefined;
        }
        return item.value;
    },
    set(key, value) {
        this._items.set(this._key(key), { value, ts: Date.now() });
        return this;
    },
    delete(key) {
        this._items.delete(this._key(key));
    },
    clear() {
        this._items.clear();
    }
};

// 3.11.2 group-message state used by the anti-delete feature scaffold.
// The source 3.11.2 file did not contain a complete delete-event restoration
// handler, so this merge preserves the concrete state tracking without inventing
// a new message-recovery flow.
const lastGroupMessages = new Map();

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

        // Save the most recent message per group, matching the concrete
        // 3.11.2 state-tracking addition.
        const jid = normalizeStoredJid(msg.key.remoteJid);
        if (jid.endsWith('@g.us')) {
            lastGroupMessages.set(jid, {
                key: msg.key,
                content: msg.message,
                sender: getSenderJid(msg),
                timestamp: msg.messageTimestamp
            });
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
    res.json({ ok: true, uptime: Math.floor((Date.now() - STARTTIME) / 1000), whatsapp: socketConnection, mode: botMode });
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
    // emitOwnEvents=true means commands sent from the linked owner account can
    // arrive with fromMe=true. That is the most reliable owner signal when
    // WhatsApp is using LID addressing and no PN alias is present.
    if (msg?.key?.fromMe === true) return true;

    const candidates = [
        getSenderJid(msg),
        normalizeStoredJid(msg?.key?.participant),
        normalizeStoredJid(msg?.key?.senderPn),
        normalizeStoredJid(msg?.key?.participantPn),
        normalizeStoredJid(msg?.key?.remoteJid),
        normalizeStoredJid(msg?.key?.remoteJidAlt)
    ].filter(Boolean);

    return candidates.includes(OWNER_JID);
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

function findContextInfo(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 12) return null;
    if (value.contextInfo && typeof value.contextInfo === 'object') return value.contextInfo;

    for (const [key, child] of Object.entries(value)) {
        if (key === 'contextInfo') continue;
        if (child && typeof child === 'object') {
            const found = findContextInfo(child, depth + 1);
            if (found) return found;
        }
    }
    return null;
}

function getQuotedMessage(msg) {
    const content = getMessageContent(msg);
    const contextInfo = findContextInfo(content) || findContextInfo(msg?.message || {});
    return contextInfo?.quotedMessage || null;
}

function unwrapWithViewOnceInfo(message = {}) {
    let current = message || {};
    let depth = 0;
    let viewOnce = false;

    while (depth++ < 12) {
        if (
            current.viewOnceMessage ||
            current.viewOnceMessageV2 ||
            current.viewOnceMessageV2Extension ||
            current.viewOnceMessageV2Extension?.message
        ) {
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

    // Some newer WhatsApp stanzas preserve the one-time flag inside context
    // metadata rather than only in the outer message wrapper.
    const contextInfo = findContextInfo(message);
    if (
        contextInfo?.isViewOnce ||
        contextInfo?.isViewOnceMessage ||
        /viewonce/i.test(JSON.stringify(contextInfo || {}))
    ) {
        // The string check is intentionally conservative; actual content
        // wrappers above remain the primary source of truth.
        if (/viewonce/i.test(JSON.stringify(contextInfo || {}))) viewOnce = true;
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
    const contextInfo = findContextInfo(msg?.message || {});
    const mentioned = contextInfo?.mentionedJid?.[0];
    return mentioned ? normalizeJid(mentioned) : null;
}

function normalizeGroupJid(value = '') {
    const raw = normalizeJid(value).trim();
    if (!raw) return '';
    if (raw.endsWith('@g.us')) return raw;
    if (/^\d+-\d+$/.test(raw)) return `${raw}@g.us`;
    return '';
}

function isGroupJid(value = '') {
    return normalizeGroupJid(value).endsWith('@g.us');
}

function getGroupSettings(jid) {
    const target = normalizeGroupJid(jid);
    if (!target) return null;
    if (!groupSettings.has(target)) {
        groupSettings.set(target, {
            antilink: 'off',
            antichannel: 'off',
            antibot: 'off',
            antidelete: 'off',
            warnCount: new Map(),
            updatedAt: Date.now()
        });
    }
    return groupSettings.get(target);
}

function participantMatchesJid(participant, jid) {
    if (!participant || !jid) return false;
    const wanted = normalizeStoredJid(jid);
    const ids = [
        participant.id,
        participant.jid,
        participant.lid,
        participant.pn,
        participant.phoneNumber,
        participant.participantPn,
        participant.participantLid
    ].filter(Boolean).map(normalizeStoredJid);

    if (ids.includes(wanted)) return true;

    for (const id of ids) {
        if (id.endsWith('@lid') && lidToPn.get(id) === wanted) return true;
        if (wanted.endsWith('@lid') && lidToPn.get(wanted) === id) return true;
    }
    return false;
}

function getBotJidCandidates(sock) {
    return [
        normalizeStoredJid(sock?.user?.id),
        normalizeStoredJid(sock?.user?.lid),
        OWNER_JID
    ].filter(Boolean);
}

function findParticipant(meta, jid) {
    return meta?.participants?.find(p => participantMatchesJid(p, jid)) || null;
}

function isParticipantAdmin(meta, jid) {
    const p = findParticipant(meta, jid);
    return Boolean(p?.admin);
}

function isBotAdmin(meta, sock) {
    return getBotJidCandidates(sock).some(jid => isParticipantAdmin(meta, jid));
}

async function getCachedGroupMetadata(sock, jid, force = false) {
    const target = normalizeGroupJid(jid);
    if (!target) throw new Error('Invalid group JID.');

    const cached = groupMetadataCache.get(target);
    if (!force && cached && Date.now() - cached.updatedAt < groupMetadataCacheTtlMs) {
        return cached.meta;
    }

    const meta = await sock.groupMetadata(target);
    groupMetadataCache.set(target, { meta, updatedAt: Date.now() });
    return meta;
}

function findGroupJidArg(args = []) {
    for (let i = 0; i < args.length; i++) {
        const target = normalizeGroupJid(args[i]);
        if (target) return { jid: target, index: i };
    }
    return { jid: '', index: -1 };
}

async function resolveGroupTarget(sock, msg, args = []) {
    const supplied = findGroupJidArg(args);
    const current = normalizeGroupJid(getChatJid(msg));
    const target = supplied.jid || current;

    if (!target) {
        throw new Error('Group only. Supply a group JID, for example 120000000000000000@g.us.');
    }

    const meta = await getCachedGroupMetadata(sock, target);
    return {
        jid: target,
        meta,
        argIndex: supplied.index,
        supplied: supplied.index >= 0,
        current
    };
}

async function requireGroupAdminCommand(sock, msg, args, { requireBotAdmin = false } = {}) {
    const target = await resolveGroupTarget(sock, msg, args);
    const requesterIsOwner = isOwner(msg);
    const requesterIsAdmin = isParticipantAdmin(target.meta, getSenderJid(msg));

    if (!requesterIsOwner && !requesterIsAdmin) {
        throw new Error('Only the group admin or bot owner can use this command for the target group.');
    }

    if (requireBotAdmin && !isBotAdmin(target.meta, sock)) {
        throw new Error('I am not an admin in the target group. Make the bot admin first.');
    }

    return target;
}

function hasAnyLink(text = '') {
    return /(?:https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/|t\.me\/|bit\.ly\/|tinyurl\.com\/)/i.test(text);
}

function hasChannelLink(text = '') {
    return /(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channel\//i.test(text) ||
        /(?:https?:\/\/)?(?:www\.)?whatsapp\.com\/channels?\//i.test(text);
}

const antiBotRepeatWindowMs = 7000;
const antiBotRepeatLimit = 3;
const antiBotRepeatMap = new Map();

function isBotLikeSpam(msg) {
    const text = getText(msg);
    if (!text || !text.startsWith(PREFIX)) return false;

    const sender = getSenderJid(msg);
    const key = `${getChatJid(msg)}:${sender}:${text.toLowerCase()}`;
    const now = Date.now();
    const record = antiBotRepeatMap.get(key) || { count: 0, firstAt: now };

    if (now - record.firstAt > antiBotRepeatWindowMs) {
        record.count = 0;
        record.firstAt = now;
    }

    record.count += 1;
    record.lastAt = now;
    antiBotRepeatMap.set(key, record);

    return record.count >= antiBotRepeatLimit;
}

async function enforceGroupRules(sock, msg) {
    const groupJid = normalizeGroupJid(getChatJid(msg));
    if (!groupJid || msg?.key?.fromMe) return false;

    const settings = groupSettings.get(groupJid);
    if (!settings) return false;

    const text = getText(msg);
    if (!text) return false;

    let meta;
    try {
        meta = await getCachedGroupMetadata(sock, groupJid);
    } catch {
        return false;
    }

    const sender = getSenderJid(msg);
    if (isParticipantAdmin(meta, sender)) return false;

    const shouldBlockLink = settings.antilink === 'on' && hasAnyLink(text);
    const shouldWarnLink = settings.antilink === 'warn' && hasAnyLink(text);
    const shouldBlockChannel = settings.antichannel === 'on' && hasChannelLink(text);
    const shouldWarnChannel = settings.antichannel === 'warn' && hasChannelLink(text);
    const shouldBlockBot = settings.antibot === 'on' && isBotLikeSpam(msg);
    const shouldWarnBot = settings.antibot === 'warn' && isBotLikeSpam(msg);

    if (!(shouldBlockLink || shouldWarnLink || shouldBlockChannel || shouldWarnChannel || shouldBlockBot || shouldWarnBot)) {
        return false;
    }

    const activeSocket = await waitForOpen(10000).catch(() => null);
    if (!activeSocket) return true;

    const botAdmin = isBotAdmin(meta, activeSocket);
    const reasons = [];
    if (shouldBlockLink || shouldWarnLink) reasons.push('link');
    if (shouldBlockChannel || shouldWarnChannel) reasons.push('channel link');
    if (shouldBlockBot || shouldWarnBot) reasons.push('repeated bot-like command');

    const mustRemove = shouldBlockLink || shouldBlockChannel || shouldBlockBot;
    if (mustRemove && botAdmin) {
        await activeSocket.groupParticipantsUpdate(groupJid, [sender], 'remove').catch(() => {});
        await safeSendMessage(groupJid, {
            text: `🛡️ Anti-system: @${sender.split('@')[0]} removed. Reason: ${reasons.join(', ')}.` ,
            mentions: [sender]
        }).catch(() => {});
        return true;
    }

    if (settings.antilink === 'warn' || settings.antichannel === 'warn' || settings.antibot === 'warn') {
        let warnCount = settings.warnCount.get(sender) || 0;
        warnCount++;
        settings.warnCount.set(sender, warnCount);

        if (warnCount >= 3) {
            if (botAdmin) {
                await activeSocket.groupParticipantsUpdate(groupJid, [sender], 'remove').catch(() => {});
                await safeSendMessage(groupJid, {
                    text: `🛡️ @${sender.split('@')[0]} KICKED — Reached 3 warnings.`,
                    mentions: [sender]
                }).catch(() => {});
            }
            settings.warnCount.delete(sender);
        } else {
            await safeSendMessage(groupJid, {
                text: `⚠️ Warning ${warnCount}/3: @${sender.split('@')[0]} — ${reasons.join(', ')} not allowed.`,
                mentions: [sender]
            }).catch(() => {});
        }
    }

    return true;
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
• .moni-admin [group_id]

〔 𝐆𝐑𝐎𝐔𝐏 〕
• .group-id [group_id]
• .antilink [group_id] on/off/warn
• .antichannel [group_id] on/off/warn
• .antibot [group_id] on/off/warn
• .antidelete on/off
• .create-group (name)
• .listadmin [group_id]

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

// 🖼️ MENU MEDIA HANDLER
function buildMenuBizNode() {
    const privacyModeTsOffset = 77980457;
    return {
        tag: 'biz',
        attrs: {
            actual_actors: '2',
            host_storage: '2',
            privacy_mode_ts: String(Math.floor(Date.now() / 1000) - privacyModeTsOffset)
        },
        content: [
            {
                tag: 'interactive',
                attrs: { type: 'native_flow', v: '1' },
                content: [
                    { tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }
                ]
            },
            {
                tag: 'quality_control',
                attrs: { source_type: 'third_party' }
            }
        ]
    };
}

async function sendMainMenu(sock, msg) {
    const chatJid = await getReplyJid(sock, msg);
    const imgPath = path.join(__dirname, 'kingmd.jpg');
    const menuText = generateMainMenu();
    const activeSocket = await waitForOpen(15000);

    if (!fs.existsSync(imgPath)) {
        const sent = await safeSendMessage(chatJid, { text: menuText });
        await storeOutgoingMessage(sent);
        return sent;
    }

    const imageBuffer = fs.readFileSync(imgPath);

    // IMPORTANT: build a complete WAMessage first and place it in getMessage's
    // store BEFORE relay. Large groups have more device fan-out/retry activity,
    // and an interactive/media message without a retrievable message body can
    // produce WhatsApp's "Waiting for this message" placeholder.
    try {
        const media = await prepareWAMessageMedia(
            { image: imageBuffer },
            { upload: activeSocket.waUploadToServer }
        );

        const interactiveMessage = proto.Message.InteractiveMessage.create({
            body: proto.Message.InteractiveMessage.Body.create({ text: menuText }),
            footer: proto.Message.InteractiveMessage.Footer.create({ text: '「🔥 KING BUG.MD • BY DARK 🔥」' }),
            header: proto.Message.InteractiveMessage.Header.create({
                title: '',
                hasMediaAttachment: true,
                ...media
            }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                buttons: [
                    proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton.create({
                        name: 'quick_reply',
                        buttonParamsJson: JSON.stringify({ display_text: 'ALL MENU', id: 'allmenu' })
                    }),
                    proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton.create({
                        name: 'quick_reply',
                        buttonParamsJson: JSON.stringify({ display_text: 'ATTACK MENU', id: 'attackmenu' })
                    }),
                    proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton.create({
                        name: 'quick_reply',
                        buttonParamsJson: JSON.stringify({ display_text: 'GROUP MENU', id: 'groupmenu' })
                    })
                ],
                messageParamsJson: '{}',
                messageVersion: 1
            })
        });

        const generated = generateWAMessageFromContent(
            chatJid,
            { interactiveMessage },
            { userJid: normalizeJid(activeSocket.user?.id || OWNER_JID) }
        );

        // Store BEFORE relay so any retry request can retrieve this exact
        // message, including its generated key/id.
        await storeOutgoingMessage(generated);

        await safeRelayMessage(
            activeSocket,
            chatJid,
            generated.message,
            {
                messageId: generated.key.id,
                additionalNodes: [buildMenuBizNode()]
            }
        );

        return generated;
    } catch (error) {
        console.warn('⚠️ Interactive .menu delivery failed; using standard media fallback:', error?.message || error);

        // Standard image+caption is the hard fallback. It is intentionally not
        // quoted, especially in groups, so the menu itself does not depend on
        // decrypting the command message on every recipient device.
        try {
            const sent = await safeSendMessage(chatJid, {
                image: imageBuffer,
                caption: `${menuText}\n\nQuick replies:\n• .allmenu\n• .attackmenu\n• .groupmenu`
            });
            await storeOutgoingMessage(sent);
            return sent;
        } catch (mediaError) {
            console.warn('⚠️ Standard media .menu fallback failed:', mediaError?.message || mediaError);
            const sent = await safeSendMessage(chatJid, {
                text: `${menuText}\n\nQuick replies:\n• .allmenu\n• .attackmenu\n• .groupmenu`
            });
            await storeOutgoingMessage(sent);
            return sent;
        }
    }
}

// 💀 HANDLE MESSAGES — FULL DESTRUCTION MODE
async function handleMessage(sock, msg) {
    const chatJid = await getReplyJid(sock, msg);
    const senderJid = getSenderJid(msg);
    const text = getText(msg);

    const reply = async (replyText, extra = {}) => {
        // Group replies are deliberately unquoted. A quoted group reply carries
        // the originating device context to every recipient and is a common
        // source of retry/decryption placeholders in large groups. The command
        // can still be identified from the visible text, and .slice continues
        // to inspect the real quoted message from the incoming command.
        const sendOptions = isGroupMessage(msg) ? {} : { quoted: msg };
        const sent = await safeSendMessage(chatJid, { text: replyText, ...extra }, sendOptions);
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

    if (command === 'private' || command === 'public') {
        if (!isOwner(msg)) {
            return reply(`
╔═══ ◈ 𝐊𝐈𝐍𝐆 𝐁𝐔𝐆.𝐌𝐃 ◈ ═══╗
        𝐀𝐂𝐂𝐄𝐒𝐒 𝐃𝐄𝐍𝐈𝐄𝐃
╚══════════════════════════╝

> ❌ Only the owner can change bot mode.
`.trim());
        }

        const action = String(args[0] || '').toLowerCase();

        if (action === 'status') {
            return reply(`> 🔐 BOT MODE: ${botMode.toUpperCase()}`);
        }

        let nextMode;
        if (command === 'private') {
            nextMode = action === 'off' ? 'public' : 'private';
        } else {
            nextMode = action === 'off' ? 'private' : 'public';
        }

        botMode = nextMode;

        const isPrivate = botMode === 'private';
        return reply(`
╔═══ ◈ 𝐊𝐈𝐍𝐆 𝐁𝐔𝐆.𝐌𝐃 ◈ ═══╗
          ${isPrivate ? '𝐏𝐑𝐈𝐕𝐀𝐓𝐄' : '𝐏𝐔𝐁𝐋𝐈𝐂'} 𝐌𝐎𝐃𝐄
╚══════════════════════════╝

> ${isPrivate ? '🔒' : '🔓'} STATUS : ${botMode.toUpperCase()}
> 👑 OWNER  : DARK
> ⚡ COMMAND: .${command} ${action || '(default)'}

> ${isPrivate ? '𝐎𝐍𝐋𝐘 𝐓𝐇𝐄 𝐎𝐖𝐍𝐄𝐑 𝐂𝐀𝐍 𝐔𝐒𝐄 𝐓𝐇𝐄 𝐁𝐎𝐓.' : '𝐀𝐋𝐋 𝐔𝐒𝐄𝐑𝐒 𝐂𝐀𝐍 𝐔𝐒𝐄 𝐓𝐇𝐄 𝐁𝐎𝐓.'}
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

    // 🚀 BAN USER — accepts an optional target group JID as the first argument.
    if (command === 'ban') {
        try {
            const targetInfo = await requireGroupAdminCommand(sock, msg, args, { requireBotAdmin: true });
            const groupArgs = [...args];
            if (targetInfo.argIndex >= 0) groupArgs.splice(targetInfo.argIndex, 1);

            const target = getMentionedJid(msg) || (
                groupArgs[0] && !normalizeGroupJid(groupArgs[0])
                    ? `${groupArgs[0].replace(/\D/g, '')}@s.whatsapp.net`
                    : null
            );
            if (!target || target === '@s.whatsapp.net') return reply('❌ No user.');

            await sock.groupParticipantsUpdate(targetInfo.jid, [target], 'remove');
            return reply(`✅ @${target.split('@')[0]} BANNED FROM TARGET GROUP.`, { mentions: [target] });
        } catch (e) {
            return reply(`❌ ${e?.message || 'Failed to ban user from the target group.'}`);
        }
    }

    // 💣 BAN-GC — existing behavior retained for the current group. It may also
    // accept a target group JID, but only owner/admin + bot-admin can invoke it.
    if (command === 'ban-gc') {
        try {
            const targetInfo = await requireGroupAdminCommand(sock, msg, args, { requireBotAdmin: true });
            const meta = targetInfo.meta;
            const nonAdmins = meta.participants.filter(p => !p.admin).map(p => p.id).filter(Boolean);
            for (let i = 0; i < nonAdmins.length; i += 10) {
                const batch = nonAdmins.slice(i, i + 10);
                await sock.groupParticipantsUpdate(targetInfo.jid, batch, 'remove').catch(() => {});
                await sleep(1500);
            }
            return reply(`⚔️ ${nonAdmins.length} MEMBERS REMOVED FROM TARGET GROUP.`);
        } catch (e) {
            return reply(`💀 ${e?.message || 'Failed to execute ban-gc.'}`);
        }
    }

    // ☠️ SUS-GC — keep the existing command available, but never silently
    // redirect it to a different group. The target is optional and exact.
    if (command === 'sus-gc') {
        if (!isOwner(msg)) return reply('❌ Owner only.');
        const supplied = findGroupJidArg(args);
        const targetJid = supplied.jid || normalizeGroupJid(getChatJid(msg));
        if (!targetJid) return reply('❌ Group only or supply a group JID.');

        const payload = {
            text: 'KING BUG.MD TEST MESSAGE',
            contextInfo: { mentionedJid: [targetJid] }
        };
        const sent = await safeSendMessage(targetJid, payload);
        await storeOutgoingMessage(sent);
        return reply('> ✅ Test payload sent only to the requested group.');
    }

    // 🆕 CREATE GROUP — concrete addition from 3.11.2.
    if (command === 'create-group') {
        try {
            const name = args.join(' ').trim() || 'KING BUG MD';
            const group = await sock.groupCreate(name, [OWNER_JID]);
            return reply(`> ✅ Group created: ${group.id}`);
        } catch (e) {
            return reply(`❌ ${e?.message || 'Failed to create group.'}`);
        }
    }

    // 🔁 ANTIDELETE TOGGLE — the second source provides the setting/state
    // toggle but no complete delete-event restoration handler. Preserve that
    // concrete flow without inventing recovery behavior.
    if (command === 'antidelete') {
        if (!isGroupMessage(msg)) return reply('❌ Group only.');
        const action = String(args[0] || '').toLowerCase();
        if (!['on', 'off'].includes(action)) return reply('❌ Use: .antidelete on/off');
        const settings = getGroupSettings(chatJid);
        if (!settings) return reply('❌ Group settings unavailable.');
        settings.antidelete = action;
        settings.updatedAt = Date.now();
        return reply(`> ✅ Antidelete → ${action.toUpperCase()}`);
    }

    // 📌 GROUP-ID — show current group ID, or verify and return a supplied ID.
    if (command === 'group-id') {
        try {
            const targetInfo = await resolveGroupTarget(sock, msg, args);
            return reply(`> 🔗 GROUP ID: ${targetInfo.jid}`);
        } catch (e) {
            return reply(`❌ ${e?.message || 'Group not found.'}`);
        }
    }

    // 🧨 Q-TEXT — send the requested text only to the exact target group. The
    // fabricated quote metadata from the old implementation is intentionally
    // gone because fake stanza context is a common cause of invalid/retry
    // messages. We use a real bot message as the quote target when possible.
    if (command === 'q-text') {
        const supplied = findGroupJidArg(args);
        if (supplied.index < 0) return reply('❌ Usage: .q-text (group_id) (text)');

        const textArgs = args.filter((_, index) => index !== supplied.index);
        const qText = textArgs.join(' ').trim();
        if (!qText) return reply('❌ Usage: .q-text (group_id) (text)');

        const targetJid = supplied.jid;
        try {
            await getCachedGroupMetadata(sock, targetJid);
            const anchor = await safeSendMessage(targetJid, { text: qText });
            await storeOutgoingMessage(anchor);
            return reply('> ✅ Text sent only to the requested group.');
        } catch (e) {
            return reply(`❌ ${e?.message || 'Failed to send to target group.'}`);
        }
    }

    // 👑 LIST ADMINS / MONI-ADMIN — exact target group support.
    if (['listadmin', 'moni-admin'].includes(command)) {
        try {
            const targetInfo = await resolveGroupTarget(sock, msg, args);
            const admins = targetInfo.meta.participants.filter(p => p.admin);
            const lines = admins.length
                ? admins.map(p => `@${String(p.id || '').split('@')[0]}`)
                : ['No admins found.'];
            const textOut = command === 'moni-admin'
                ? `> 👑 TARGET GROUP ADMINS\n\n${lines.join('\\n')}\n\n> 🤖 BOT ADMIN: ${isBotAdmin(targetInfo.meta, sock) ? 'YES' : 'NO'}`
                : `> 👑 ADMINS:\n${lines.join('\\n')}`;
            return reply(textOut, { mentions: admins.map(p => p.id).filter(Boolean) });
        } catch (e) {
            return reply(`❌ ${e?.message || 'Failed to read target group admins.'}`);
        }
    }

    // 🔐 ANTI FEATURES — per-group and exact-target. Syntax:
    // .antilink [group_jid] on/off/warn
    // .antichannel [group_jid] on/off/warn
    // .antibot [group_jid] on/off/warn
    if (['antilink', 'antichannel', 'antibot'].includes(command)) {
        const actionIndex = args.findIndex(a => ['on', 'off', 'warn'].includes(String(a).toLowerCase()));
        if (actionIndex < 0) return reply(`❌ Use: .${command} [group_jid] on/off/warn`);

        const action = String(args[actionIndex]).toLowerCase();
        try {
            const targetInfo = await requireGroupAdminCommand(sock, msg, args, { requireBotAdmin: action === 'on' });
            const settings = getGroupSettings(targetInfo.jid);
            settings[command] = action;
            settings.updatedAt = Date.now();

            return reply(
                `> ✅ ${command.toUpperCase()} → ${action.toUpperCase()}\n> 🎯 GROUP → ${targetInfo.jid}\n> 🤖 BOT ADMIN → ${isBotAdmin(targetInfo.meta, sock) ? 'YES' : 'NO'}`
            );
        } catch (e) {
            return reply(`❌ ${e?.message || 'Failed to update group protection.'}`);
        }
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
        msgRetryCounterCache,
        cachedGroupMetadata: async (jid) => {
            try {
                return await getCachedGroupMetadata(sock, jid);
            } catch {
                return undefined;
            }
        },

        // Baileys expects getMessage to return the inner proto.Message
        // body, not the complete WAMessage wrapper stored by our message store.
        // Returning the wrapper can make retry/decryption fail with the
        // "Waiting for this message" placeholder, especially in groups
        // with multiple recipient devices.
        getMessage: async (key) => {
            const stored = store.loadMessage(key?.remoteJid, key?.id);
            return stored?.message || undefined;
        }
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

    sock.ev.on('groups.update', async (updates = []) => {
        for (const update of updates || []) {
            const id = normalizeGroupJid(update?.id);
            if (!id) continue;
            try {
                const meta = await sock.groupMetadata(id);
                groupMetadataCache.set(id, { meta, updatedAt: Date.now() });
            } catch {}
        }
    });

    sock.ev.on('group-participants.update', async (event) => {
        const id = normalizeGroupJid(event?.id);
        if (!id) return;
        try {
            const meta = await sock.groupMetadata(id);
            groupMetadataCache.set(id, { meta, updatedAt: Date.now() });
        } catch {}
    });

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
                const handledByGroupRule = await enforceGroupRules(sock, msg);
                if (!handledByGroupRule) {
                    await handleMessage(sock, msg);
                }
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
    .then(() => console.log('💀🔥 KING BUG.MD — FULLY ARMED AND ONLINE (3.11.2 / FULL MERGE + VIEWONCE + GROUP WARNING STATE)'))
    .catch(err => console.error('💥 BOT FAILED:', err));

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Server running on port ${PORT}`);
    startKeepAlive();
});

