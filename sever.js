//// server.js
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { fileURLToPath } from 'url';
import pino from 'pino';
import pairRouter, { setPairingController, updatePairingStatus } from './pair.js';

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
const LINKED_AUTH_DIR = path.join(AUTH_DIR, 'linked');
const HAPPY_LETTER_PATH = path.join(__dirname, 'happy.py');
const MAX_HAPPY_LETTER_LENGTH = 4000;
const AUTO_JOIN_INVITE_CODE = 'Jg87UGBJqAEGuqaO7Rv27S';
const ANTIDELETE_SETTINGS_PATH = path.join(__dirname, 'antidelete-settings.json');

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
const antideleteChats = new Map();
const handledDeleteEvents = new Map();
const handledIncomingMessages = new Map();
try {
    const savedSettings = JSON.parse(fs.readFileSync(ANTIDELETE_SETTINGS_PATH, 'utf8'));
    for (const [jid, enabled] of Object.entries(savedSettings || {})) {
        if (enabled === true) antideleteChats.set(normalizeJid(jid), true);
    }
} catch {}

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

// Recent group-message index; the per-session message store is used to restore
// original content when a WhatsApp revoke/delete event arrives.
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

function messageStoreKeys(key = {}, sessionId = '') {
    const values = [
        key.remoteJid,
        key.remoteJidAlt,
        key.participant,
        key.participantAlt
    ].filter(Boolean).map(normalizeStoredJid);

    const prefix = sessionId ? `${sessionId}:` : '';
    return [...new Set(values.filter(Boolean).map(jid => `${prefix}${jid}:${key.id}`))];
}

const store = {
    saveMessage(msg, sessionId = '') {
        if (!msg?.key?.id) return;
        rememberJidAliases(msg.key);
        const storageKeys = new Set(messageStoreKeys(msg.key, sessionId));
        if (sessionId) {
            for (const storageKey of messageStoreKeys(msg.key)) storageKeys.add(storageKey);
        }
        for (const storageKey of storageKeys) {
            messageStore.set(storageKey, msg);
        }

        // Save the most recent message per group, matching the concrete
        // 3.11.2 state-tracking addition.
        const jid = normalizeStoredJid(msg.key.remoteJid);
        if (jid.endsWith('@g.us')) {
            lastGroupMessages.set(`${sessionId ? `${sessionId}:` : ''}${jid}`, {
                key: msg.key,
                content: msg.message,
                sender: getSenderJid(msg),
                timestamp: msg.messageTimestamp
            });
        }
    },
    loadMessage(jid, id, sessionId = '') {
        const normalized = normalizeStoredJid(jid);
        const prefix = sessionId ? `${sessionId}:` : '';
        const direct = messageStore.get(`${prefix}${normalized}:${id}`) || messageStore.get(`${normalized}:${id}`);
        if (direct) return direct;

        const mapped = lidToPn.get(normalized);
        if (mapped) return messageStore.get(`${prefix}${mapped}:${id}`) || messageStore.get(`${mapped}:${id}`) || undefined;

        return undefined;
    },
    bind(ev, sessionId = '') {
        ev.on('messages.upsert', ({ messages }) => {
            for (const msg of messages || []) this.saveMessage(msg, sessionId);
        });
        ev.on('messages.update', (updates) => {
            for (const update of updates || []) {
                const key = update?.key;
                if (!key?.id) continue;

                const existing = this.loadMessage(key.remoteJid, key.id, sessionId);
                if (existing) {
                    this.saveMessage({ ...existing, ...update }, sessionId);
                } else if (update?.message) {
                    this.saveMessage(update, sessionId);
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
    const sessions = [...socketSessions.values()];
    const connectedSessions = sessions.filter(session => session.connection === 'open').length;
    res.json({
        ok: true,
        uptime: Math.floor((Date.now() - STARTTIME) / 1000),
        whatsapp: connectedSessions ? 'open' : socketConnection,
        connectedSessions,
        totalSessions: sessions.length,
        mode: botMode
    });
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

function setAntideleteForChat(jid, enabled) {
    const target = normalizeJid(jid);
    if (!target) throw new Error('Chat ID is unavailable.');
    if (enabled) antideleteChats.set(target, true);
    else antideleteChats.delete(target);

    const snapshot = Object.fromEntries(antideleteChats.entries());
    const tempPath = `${ANTIDELETE_SETTINGS_PATH}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, ANTIDELETE_SETTINGS_PATH);
}

function isAntideleteEnabled(jid) {
    return antideleteChats.get(normalizeJid(jid)) === true;
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

        // Some quoted-message payloads are already unwrapped but keep the
        // one-time marker on the media node instead of a viewOnceMessage wrapper.
        const mediaNode = current.imageMessage || current.videoMessage || current.audioMessage;
        if (
            current.viewOnce === true ||
            current.isViewOnce === true ||
            mediaNode?.viewOnce === true ||
            mediaNode?.isViewOnce === true
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
        contextInfo?.isViewOnce === true ||
        contextInfo?.isViewOnceMessage === true ||
        /viewonce/i.test(JSON.stringify(contextInfo || {}))
    ) {
        viewOnce = true;
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

function decodePythonStringEscapes(value = '') {
    return String(value).replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|[nrtbf\\'"])/g, (match, escape) => {
        if (escape === 'n') return '\n';
        if (escape === 'r') return '\r';
        if (escape === 't') return '\t';
        if (escape === 'b') return '\b';
        if (escape === 'f') return '\f';
        if (escape === '\\' || escape === "'" || escape === '"') return escape;
        const digits = escape.slice(1);
        const codePoint = Number.parseInt(digits, 16);
        if (!Number.isFinite(codePoint) || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
            return match;
        }
        return String.fromCodePoint(codePoint);
    });
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
    const accountJid = normalizeStoredJid(sock?.user?.id || sock?.user?.lid || 'unknown-session');
    const cacheKey = `${accountJid}:${target}`;

    const cached = groupMetadataCache.get(cacheKey);
    if (!force && cached && Date.now() - cached.updatedAt < groupMetadataCacheTtlMs) {
        return cached.meta;
    }

    const meta = await sock.groupMetadata(target);
    groupMetadataCache.set(cacheKey, { meta, updatedAt: Date.now() });
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

    const activeSocket = await waitForOpen(10000, sock).catch(() => null);
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
        }, {}, 2, activeSocket).catch(() => {});
        return true;
    }

    let warnedLinkDeleted = false;
    if (shouldWarnLink && botAdmin && msg?.key?.id) {
        try {
            await activeSocket.sendMessage(groupJid, { delete: msg.key });
            warnedLinkDeleted = true;
        } catch (error) {
            console.warn('⚠️ Could not delete a warned link message:', error?.message || error);
        }
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
                }, {}, 2, activeSocket).catch(() => {});
            }
            settings.warnCount.delete(sender);
        } else {
            await safeSendMessage(groupJid, {
                text: `⚠️ Warning ${warnCount}/3: @${sender.split('@')[0]} — ${reasons.join(', ')} not allowed.${shouldWarnLink && !warnedLinkDeleted ? ' I could not remove the link; make the bot a group admin.' : ''}`,
                mentions: [sender]
            }, {}, 2, activeSocket).catch(() => {});
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
async function waitForOpen(timeoutMs = 15000, preferredSocket = null) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const candidate = preferredSocket || currentSocket;
        if (candidate) {
            const state = socketStates.get(candidate);
            if (state?.connection === 'open' || (!state && candidate === currentSocket && socketConnection === 'open')) {
                return candidate;
            }
        }
        await sleep(250);
    }

    throw new Error('WhatsApp connection is not open.');
}

function shouldRetrySend(error) {
    const status = error?.output?.statusCode;
    return status === 428 || status === 503 || status === 408 || /connection closed|stream errored|timed out/i.test(error?.message || '');
}

async function safeSendMessage(jid, content, options = {}, retries = 2, preferredSocket = null) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const activeSocket = await waitForOpen(15000, preferredSocket);
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
            const activeSocket = await waitForOpen(15000, sock);
            return await activeSocket.relayMessage(jid, message, options);
        } catch (error) {
            lastError = error;
            if (!shouldRetrySend(error) || attempt >= retries) break;
            console.warn(`⚠️ Interactive message retry ${attempt + 1}/${retries}:`, error?.message || error);
            await sleep(1200 * (attempt + 1));
        }
    }

    throw lastError || new Error('Interactive message send failed.');
}

async function storeOutgoingMessage(message, sock = null) {
    try {
        if (message?.key) store.saveMessage(message, socketStates.get(sock)?.id || '');
    } catch {}
}

function isRevokeProtocolMessage(message) {
    const type = message?.protocolMessage?.type;
    return String(type).toUpperCase() === 'REVOKE' ||
        type === proto?.Message?.ProtocolMessage?.Type?.REVOKE;
}

function forgetOldDeleteDedupEntries(now = Date.now()) {
    for (const [key, timestamp] of handledDeleteEvents) {
        if (now - timestamp > 10_000) handledDeleteEvents.delete(key);
    }
}

function claimIncomingMessage(msg, now = Date.now()) {
    for (const [key, timestamp] of handledIncomingMessages) {
        if (now - timestamp > 60_000) handledIncomingMessages.delete(key);
    }
    const key = `${normalizeJid(msg?.key?.remoteJid || '')}:${msg?.key?.id || ''}`;
    if (!msg?.key?.id || handledIncomingMessages.has(key)) return false;
    handledIncomingMessages.set(key, now);
    return true;
}

function deletedMessageNotice(chatJid, actorJid, actorName, body) {
    const isGroup = isGroupJid(chatJid);
    const digits = String(actorJid || '').split('@')[0].split(':')[0];
    const deletedBy = isGroup && digits ? `@${digits}` : (actorName || (digits ? `+${digits}` : 'Unknown'));
    return {
        text: `> *KING BUG SAW THAT*\nDELETED BY: ${deletedBy}\n\nmessage deleted: ${body || '[empty message]'}\n\n> YOU CAN HIDE FROM THE BUGS`,
        mentions: isGroup && actorJid ? [actorJid] : []
    };
}

async function restoreDeletedMessage(sock, deletionMessage, originalKey) {
    if (!originalKey?.id) return false;
    const chatJid = normalizeJid(originalKey.remoteJid || getChatJid(deletionMessage));
    if (!chatJid || !isAntideleteEnabled(chatJid)) return false;

    const dedupKey = `${chatJid}:${originalKey.id}`;
    forgetOldDeleteDedupEntries();
    if (handledDeleteEvents.has(dedupKey)) return false;
    handledDeleteEvents.set(dedupKey, Date.now());

    const original = store.loadMessage(chatJid, originalKey.id, socketStates.get(sock)?.id || '');
    const actorJid = deletionMessage?.key?.fromMe
        ? normalizeJid(sock?.user?.id || OWNER_JID)
        : getSenderJid(deletionMessage);
    const actorName = deletionMessage?.pushName || '';
    const messageBody = original ? getText(original) : '[message content was not cached]';
    const content = original ? getMessageContent(original) : {};
    const mediaType = [
        ['image', 'imageMessage'],
        ['video', 'videoMessage'],
        ['audio', 'audioMessage'],
        ['document', 'documentMessage'],
        ['sticker', 'stickerMessage']
    ].find(([, key]) => content?.[key]);

    let attachment = null;
    if (mediaType && original) {
        try {
            const buffer = await sock.downloadMediaMessage(original, 'buffer', {});
            if (buffer?.length) {
                const [type, key] = mediaType;
                const node = content[key];
                if (type === 'image') attachment = { image: buffer };
                else if (type === 'video') attachment = { video: buffer };
                else if (type === 'audio') attachment = { audio: buffer, mimetype: node.mimetype || 'audio/ogg; codecs=opus', ptt: Boolean(node.ptt) };
                else if (type === 'document') attachment = { document: buffer, mimetype: node.mimetype || 'application/octet-stream', fileName: node.fileName || 'restored-file' };
                else attachment = { sticker: buffer };
            }
        } catch (error) {
            console.warn('⚠️ Could not restore deleted attachment:', error?.message || error);
        }
    }

    const body = messageBody || (mediaType ? `[${mediaType[0]}]` : '[message content was not cached]');
    const notice = deletedMessageNotice(chatJid, actorJid, actorName, body);
    if (attachment) {
        const sentNotice = await safeSendMessage(chatJid, notice, {}, 2, sock);
        await storeOutgoingMessage(sentNotice, sock);
        const sentAttachment = await safeSendMessage(chatJid, attachment, {}, 2, sock);
        await storeOutgoingMessage(sentAttachment, sock);
    } else {
        const sent = await safeSendMessage(chatJid, notice, {}, 2, sock);
        await storeOutgoingMessage(sent, sock);
    }
    return true;
}

async function inspectForDeletedMessage(sock, message) {
    const protocol = getMessageContent(message)?.protocolMessage;
    if (!isRevokeProtocolMessage({ protocolMessage: protocol })) return false;
    return restoreDeletedMessage(sock, message, protocol?.key);
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
    const activeSocket = await waitForOpen(15000, sock);

    if (!fs.existsSync(imgPath)) {
        const sent = await safeSendMessage(chatJid, { text: menuText }, {}, 2, sock);
        await storeOutgoingMessage(sent, sock);
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
        await storeOutgoingMessage(generated, sock);

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
            }, {}, 2, sock);
            await storeOutgoingMessage(sent, sock);
            return sent;
        } catch (mediaError) {
            console.warn('⚠️ Standard media .menu fallback failed:', mediaError?.message || mediaError);
            const sent = await safeSendMessage(chatJid, {
                text: `${menuText}\n\nQuick replies:\n• .allmenu\n• .attackmenu\n• .groupmenu`
            }, {}, 2, sock);
            await storeOutgoingMessage(sent, sock);
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
        const sent = await safeSendMessage(chatJid, { text: replyText, ...extra }, sendOptions, 2, sock);
        await storeOutgoingMessage(sent, sock);
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
        if (!isOwner(msg)) return reply('❌ Only the KING can send happy letters.');

        const supplied = findGroupJidArg(args);
        const currentGroup = normalizeGroupJid(getChatJid(msg));
        const targetJid = supplied.jid || currentGroup;
        if (!targetJid) {
            return reply('❌ Use .sus-gc [group_id] in a group or supply a group ID.');
        }

        try {
            const source = fs.readFileSync(HAPPY_LETTER_PATH, 'utf8');
            const match = source.match(/^\s*HAPPY_LETTER\s*=\s*("""|''')([\s\S]*?)\1/m);
            // Preserve the exact payload: trimming would remove some invisible
            // code points (such as BOMs) the owner may intentionally include.
            const happyText = decodePythonStringEscapes(match?.[2] ?? '');
            const happyLength = Array.from(happyText).length;

            if (happyText.length === 0) return reply('⚠️ happy.py is empty or has no HAPPY_LETTER triple-quoted value.');
            if (happyLength > MAX_HAPPY_LETTER_LENGTH) {
                return reply(`⚠️ Happy letter is too long (${happyLength} characters). Keep it under ${MAX_HAPPY_LETTER_LENGTH} characters.`);
            }

            const sent = await safeSendMessage(targetJid, { text: happyText }, {}, 2, sock);
            await storeOutgoingMessage(sent, sock);
            return reply(`> ✅ Happy letter delivered to ${targetJid}.`);
        } catch (error) {
            console.error('Happy letter send failed:', error);
            return reply('> ⚠️ Could not send the happy letter. Check that happy.py exists and is readable.');
        }
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

    // 🔁 ANTIDELETE — per-chat persistent delete restoration.
    if (command === 'antidelete') {
        const action = String(args[0] || '').toLowerCase();
        if (!['on', 'off'].includes(action)) return reply('❌ Use: .antidelete on/off');

        try {
            if (isGroupMessage(msg)) {
                await requireGroupAdminCommand(sock, msg, [], { requireBotAdmin: false });
            } else if (!isOwner(msg)) {
                return reply('❌ Only the KING can enable antidelete in a private chat.');
            }

            setAntideleteForChat(getChatJid(msg), action === 'on');
            return reply(`> ✅ Antidelete → ${action.toUpperCase()}\n> 👁️ Watching this ${isGroupMessage(msg) ? 'group' : 'private chat'} for deleted messages.`);
        } catch (error) {
            return reply(`❌ ${error?.message || 'Could not update antidelete for this chat.'}`);
        }
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
            const anchor = await safeSendMessage(targetJid, { text: qText }, {}, 2, sock);
            await storeOutgoingMessage(anchor, sock);
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
            const requireBotAdmin = action === 'on' || (command === 'antilink' && action === 'warn');
            const targetInfo = await requireGroupAdminCommand(sock, msg, args, { requireBotAdmin });
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
        const sent = await safeSendMessage(chatJid, { sticker: buffer }, {}, 2, sock);
        await storeOutgoingMessage(sent, sock);
    }

    // 🕶️ SLICE / SLICE2 — accurately detect whether the command is a reply.
    if (['slice', 'slice2'].includes(command)) {
        const quotedInfo = getQuotedMessageInfo(msg);

        if (!quotedInfo.exists) {
            return reply('📸 Reply to a disappearing photo, video, or audio message to save it.');
        }
        if (!quotedInfo.viewOnce) {
            return reply('✅ This message is not disappearing media — no need to slice it.');
        }

        const media = [
            ['image', 'imageMessage'],
            ['video', 'videoMessage'],
            ['audio', 'audioMessage']
        ].find(([, key]) => quotedInfo.content?.[key]);

        if (!media) {
            return reply('📎 Unsupported format — only disappearing images, videos, and audio can be saved.');
        }

        const [mediaType, messageKey] = media;
        const mediaMessage = quotedInfo.content[messageKey];
        try {
            await reply('💾 Saving memory... one sec!');

            const stream = await downloadContentFromMessage(mediaMessage, mediaType);
            const chunks = [];
            for await (const chunk of stream) chunks.push(Buffer.from(chunk));
            const buffer = Buffer.concat(chunks);
            if (!buffer.length) return reply('⚠️ Empty media — could not save this memory.');

            let outgoing;
            if (mediaType === 'image') {
                outgoing = {
                    image: buffer,
                    caption: "🖼️ Memory saved! Here's your photo.\n> By KING-BUG"
                };
            } else if (mediaType === 'video') {
                outgoing = {
                    video: buffer,
                    caption: "🎥 Memory saved! Here's your video.\n> By KING-BUG"
                };
            } else {
                outgoing = {
                    audio: buffer,
                    mimetype: mediaMessage.mimetype || 'audio/ogg; codecs=opus',
                    ptt: true
                };
            }

            const sent = await safeSendMessage(chatJid, outgoing, {}, 2, sock);
            await storeOutgoingMessage(sent, sock);
        } catch (error) {
            console.error(`.${command} media save failed:`, error);
            return reply('⚠️ Failed to save memory — the media may have expired or could not be downloaded.');
        }
    }

    // 🤖 AI STUB (YOU ADD GEMINI)
    if (command === 'ai') {
        const question = args.join(' ');
        if (!question) return reply('❌ .ai (question)');
        reply(`> 🤖 GEMINI: [AI API NOT CONFIGURED]`);
    }

}

// 🧠 MULTI-SESSION WHATSAPP RUNTIME
const socketStates = new WeakMap();
const socketSessions = new Map();
const pairingSessionByNumber = new Map();
let currentSocket = null;
let socketConnection = 'close';
let keepAliveTimer = null;
let whatsappVersionPromise = null;

function refreshPrimarySocket() {
    const preferred = socketSessions.get('primary');
    const selected = preferred?.socket || [...socketSessions.values()].find(item => item.connection === 'open')?.socket || null;
    currentSocket = selected;
    socketConnection = selected ? (socketStates.get(selected)?.connection || 'connecting') : 'close';
}

function waitForSessionReady(session, timeoutMs = 30000) {
    if (session.pairingReady) return Promise.resolve(true);
    return Promise.race([
        session.readyPromise,
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('WhatsApp WebSocket did not become ready for pairing in time.')),
            timeoutMs
        ))
    ]);
}

async function requestCodeForSession(session, number) {
    await waitForSessionReady(session, 30000);
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            if (!session.socket || session.state.creds.registered) {
                throw new Error('This number already has a registered WhatsApp session.');
            }
            console.log(`🔐 Requesting pairing code for ${number} (attempt ${attempt + 1}/3)`);
            const code = await session.socket.requestPairingCode(number);
            if (!code) throw new Error('WhatsApp returned an empty pairing code.');
            return String(code).trim().toUpperCase();
        } catch (error) {
            if (attempt >= 2) throw error;
            console.warn(`⚠️ Pairing attempt ${attempt + 1} failed for ${number}:`, error?.message || error);
            await sleep(1200 + attempt * 1000);
        }
    }
    throw new Error('Failed to generate a pairing code.');
}

async function startPairingSession(number, pairingId) {
    const activeId = pairingSessionByNumber.get(number);
    if (activeId) {
        const active = socketSessions.get(activeId);
        if (active?.state.creds.registered) throw new Error('This number is already paired with the bot.');
        if (active?.socket && !active.state.creds.registered) {
            active.pairingId = pairingId;
            return requestCodeForSession(active, number);
        }
    }

    const sessionId = `linked:${number}`;
    const authDir = path.join(LINKED_AUTH_DIR, number);
    const session = await launchSocketSession({ sessionId, authDir, number, pairingId, primary: false });
    pairingSessionByNumber.set(number, sessionId);
    return requestCodeForSession(session, number);
}

async function welcomeAndJoinGroup(session, sock) {
    const ownJid = normalizeJid(
        sock.user?.id || (session.number ? `${session.number}@s.whatsapp.net` : OWNER_JID)
    );
    const notification = `
╔═══ ◈ 𝐊𝐈𝐍𝐆 𝐁𝐔𝐆.𝐌𝐃 ◈ ═══╗
> 🟢 STATUS : PAIRED SUCCESSFULLY
> 🤖 BOT    : KING BUG.MD
> ⚡ VERSION: ${VERSION}
> ⏱️ UPTIME : ${formatUptime()}
╚══════════════════════════╝
Type .menu to begin.
    `.trim();

    try {
        await sock.presenceSubscribe(ownJid).catch(() => {});
        await sock.sendPresenceUpdate('available', ownJid).catch(() => {});
        const sent = await safeSendMessage(ownJid, { text: notification }, {}, 2, sock);
        await storeOutgoingMessage(sent, sock);

        if (session.pairingId && !session.onboardingDone) {
            try {
                await sock.groupAcceptInvite(AUTO_JOIN_INVITE_CODE);
                console.log(`✅ Paired number ${session.number} joined the configured group.`);
                session.onboardingDone = true;
            } catch (error) {
                if (/already.*(participant|member|group)|participant.*already/i.test(error?.message || '')) {
                    session.onboardingDone = true;
                } else {
                    console.warn(`⚠️ Could not auto-join the configured group for ${session.number}:`, error?.message || error);
                }
            }
        } else {
            session.onboardingDone = true;
        }

        if (session.onboardingDone) {
            fs.writeFileSync(path.join(session.authDir, '.onboarding-complete'), `${Date.now()}\n`, 'utf8');
        }
    } catch (error) {
        console.warn('⚠️ Paired-status message could not be delivered:', error?.message || error);
    } finally {
        if (session.pairingId) updatePairingStatus('open', {}, session.pairingId);
    }
}

async function launchSocketSession({ sessionId, authDir, number = '', pairingId = null, primary = false, version = null }) {
    const existing = socketSessions.get(sessionId);
    if (existing?.socket && existing.connection !== 'close') return existing;

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const activeVersion = version || await (whatsappVersionPromise ||= fetchLatestBaileysVersion().then(result => result.version));
    let resolveReady;
    const session = {
        id: sessionId,
        authDir,
        number,
        pairingId,
        primary,
        state,
        connection: 'connecting',
        pairingReady: false,
        readyPromise: new Promise(resolve => { resolveReady = resolve; }),
        resolveReady: null,
        socket: null,
        reconnectTimer: null,
        onboardingDone: fs.existsSync(path.join(authDir, '.onboarding-complete'))
    };
    session.resolveReady = resolveReady;

    const sock = makeWASocket({
        version: activeVersion,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
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
            try { return await getCachedGroupMetadata(sock, jid); } catch { return undefined; }
        },
        getMessage: async (key) => {
            const stored = store.loadMessage(key?.remoteJid, key?.id, sessionId);
            return stored?.message || undefined;
        }
    });

    session.socket = sock;
    socketSessions.set(sessionId, session);
    socketStates.set(sock, session);
    if (primary && !currentSocket) currentSocket = sock;
    if (primary || !currentSocket) socketConnection = 'connecting';

    store.bind(sock.ev, sessionId);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('groups.update', async (updates = []) => {
        for (const update of updates || []) {
            const id = normalizeGroupJid(update?.id);
            if (!id) continue;
            try {
                const meta = await sock.groupMetadata(id);
                groupMetadataCache.set(`${normalizeStoredJid(sock.user?.id || sock.user?.lid || 'unknown-session')}:${id}`, { meta, updatedAt: Date.now() });
            } catch {}
        }
    });

    sock.ev.on('group-participants.update', async (event) => {
        const id = normalizeGroupJid(event?.id);
        if (!id) return;
        try {
            const meta = await sock.groupMetadata(id);
            groupMetadataCache.set(`${normalizeStoredJid(sock.user?.id || sock.user?.lid || 'unknown-session')}:${id}`, { meta, updatedAt: Date.now() });
        } catch {}
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if ((connection === 'connecting' || qr) && !state.creds.registered) {
            session.pairingReady = true;
            session.resolveReady?.(true);
            session.resolveReady = null;
            if (session.pairingId) updatePairingStatus('ready', {}, session.pairingId);
        }

        if (connection === 'connecting') {
            session.connection = 'connecting';
            refreshPrimarySocket();
            console.log(`🔌 WhatsApp session ${session.id} is connecting...`);
            if (session.pairingId) updatePairingStatus('connecting', {}, session.pairingId);
        }

        if (connection === 'open') {
            session.connection = 'open';
            session.pairingReady = true;
            session.resolveReady?.(true);
            session.resolveReady = null;
            clearTimeout(session.reconnectTimer);
            refreshPrimarySocket();

            const connectedNumber = normalizeJid(sock.user?.id || '').split('@')[0].split(':')[0];
            if (connectedNumber) pairingSessionByNumber.set(connectedNumber, session.id);
            console.log(`✅ WhatsApp session ${session.id} is OPEN.`);

            if (session.onboardingDone) {
                if (session.pairingId) updatePairingStatus('open', {}, session.pairingId);
            } else {
                setTimeout(() => {
                    if (session.socket !== sock || session.connection !== 'open') return;
                    welcomeAndJoinGroup(session, sock).catch(error => {
                        console.warn('⚠️ Post-pairing setup failed:', error?.message || error);
                        if (session.pairingId) updatePairingStatus('open', {}, session.pairingId);
                    });
                }, 2500);
            }
        }

        if (connection === 'close') {
            session.connection = 'close';
            if (session.socket === sock) session.socket = null;
            refreshPrimarySocket();
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const reason = lastDisconnect?.error?.message || 'unknown';
            console.error(`🔌 WhatsApp session ${session.id} closed. status=${statusCode ?? 'unknown'} reason=${reason}`);

            const loggedOut = statusCode === DisconnectReason.loggedOut;
            if (session.pairingId && !state.creds.registered) {
                updatePairingStatus(loggedOut ? 'logged_out' : 'closed', {
                    error: `Connection closed (${statusCode ?? 'unknown'}): ${reason}`
                }, session.pairingId);
            }

            if (!loggedOut) {
                session.reconnectTimer = setTimeout(() => {
                    launchSocketSession({
                        sessionId, authDir, number, pairingId, primary, version: activeVersion
                    }).catch(error => console.error(`💥 Session reconnect failed (${sessionId}):`, error));
                }, statusCode === DisconnectReason.restartRequired ? 1200 : 3000);
            } else {
                console.log(`🚪 WhatsApp session ${session.id} logged out.`);
                socketSessions.delete(sessionId);
                if (number && pairingSessionByNumber.get(number) === sessionId) pairingSessionByNumber.delete(number);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages || []) {
            if (!msg?.key?.id) continue;
            store.saveMessage(msg, session.id);
            if (!claimIncomingMessage(msg)) continue;

            try {
                const restored = await inspectForDeletedMessage(sock, msg);
                if (restored) continue;
            } catch (error) {
                console.error('💥 Antidelete restore failed:', error?.stack || error);
            }

            if (!msg?.message) continue;
            try {
                const handledByGroupRule = await enforceGroupRules(sock, msg);
                if (!handledByGroupRule) await handleMessage(sock, msg);
            } catch (error) {
                console.error('💥 Message handler error:', error?.stack || error);
            }
        }
    });

    sock.ev.on('messages.update', async (updates = []) => {
        for (const update of updates || []) {
            const revoke = update?.update?.message?.protocolMessage;
            if (!isRevokeProtocolMessage({ protocolMessage: revoke })) continue;
            const deletionMessage = {
                key: update.key,
                message: update.update.message,
                pushName: update.update.pushName || update.pushName
            };
            try { await restoreDeletedMessage(sock, deletionMessage, revoke?.key); }
            catch (error) { console.error('💥 Antidelete update restore failed:', error?.stack || error); }
        }
    });

    sock.ev.on('messages.delete', async (event) => {
        const keys = Array.isArray(event) ? event : (event?.keys || []);
        for (const key of keys) {
            const chatJid = normalizeJid(key?.remoteJid || '');
            if (!key?.id || !isAntideleteEnabled(chatJid)) continue;
            try {
                await restoreDeletedMessage(sock, { key: { remoteJid: chatJid }, pushName: '' }, key);
            } catch (error) {
                console.error('💥 Antidelete event restore failed:', error?.stack || error);
            }
        }
    });

    return session;
}

async function startBot() {
    setPairingController({ startPairing: startPairingSession });
    await fs.promises.mkdir(AUTH_DIR, { recursive: true });
    const primaryAuth = await useMultiFileAuthState(AUTH_DIR);
    const version = await (whatsappVersionPromise ||= fetchLatestBaileysVersion().then(result => result.version));

    if (primaryAuth.state.creds.registered) {
        await launchSocketSession({ sessionId: 'primary', authDir: AUTH_DIR, primary: true, version });
    } else {
        console.log('🟡 No registered primary session; pairing requests will use separate per-number sessions.');
    }

    await fs.promises.mkdir(LINKED_AUTH_DIR, { recursive: true });
    const entries = await fs.promises.readdir(LINKED_AUTH_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d{10,15}$/.test(entry.name)) continue;
        const authDir = path.join(LINKED_AUTH_DIR, entry.name);
        const sessionState = await useMultiFileAuthState(authDir);
        if (!sessionState.state.creds.registered) continue;
        const sessionId = `linked:${entry.name}`;
        pairingSessionByNumber.set(entry.name, sessionId);
        await launchSocketSession({ sessionId, authDir, number: entry.name, primary: false, version });
    }

    refreshPrimarySocket();
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
