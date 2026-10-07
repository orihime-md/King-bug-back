import express from 'express';

const router = express.Router();

let whatsappSocket = null;
let socketStateGetter = null;
let getRegisteredState = null;

export function setPairingSocket(sock, state = {}) {
    whatsappSocket = sock;
    socketStateGetter = typeof state.getState === 'function'
        ? state.getState
        : null;
    getRegisteredState = typeof state.getRegistered === 'function'
        ? state.getRegistered
        : null;
}

function getSocketState() {
    try {
        return socketStateGetter ? socketStateGetter() : 'unknown';
    } catch {
        return 'unknown';
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

router.get('/api/pair', async (req, res) => {
    try {
        const number = String(req.query.number || '').replace(/\D/g, '');

        if (!number) {
            return res.status(400).json({ ok: false, error: 'Phone number is required.' });
        }

        if (number.length < 10 || number.length > 15) {
            return res.status(400).json({ ok: false, error: 'Invalid phone number. Use country code and digits only.' });
        }

        const deadline = Date.now() + 15000;
        while ((!whatsappSocket || getSocketState() === 'close') && Date.now() < deadline) {
            await sleep(250);
        }

        const sock = whatsappSocket;
        if (!sock || getSocketState() === 'close') {
            return res.status(503).json({
                ok: false,
                error: 'WhatsApp socket is reconnecting. Wait a few seconds and try again.'
            });
        }

        const registered = typeof getRegisteredState === 'function'
            ? getRegisteredState()
            : !!sock.authState?.creds?.registered;

        if (registered) {
            return res.status(409).json({
                ok: false,
                error: 'This WhatsApp session is already registered. Remove the existing auth session before pairing a new number.'
            });
        }

        // Baileys exposes waitForSocketOpen(). Use it to avoid generating
        // a code against a WebSocket that is still connecting/reconnecting.
        if (typeof sock.waitForSocketOpen === 'function') {
            console.log('⏳ Waiting for the WhatsApp WebSocket to open...');
            await sock.waitForSocketOpen();
        } else {
            // Fallback for builds that do not expose waitForSocketOpen().
            const readyDeadline = Date.now() + 10000;
            while (getSocketState() !== 'connecting' && Date.now() < readyDeadline) {
                await sleep(250);
            }
        }

        console.log(`🔐 Pairing code requested for ${number}`);
        const rawCode = await sock.requestPairingCode(number);
        const code = String(rawCode || '').trim().toUpperCase();

        if (!code) {
            return res.status(502).json({
                ok: false,
                error: 'WhatsApp did not return a pairing code.'
            });
        }

        // Keep the code exactly as Baileys returned it. Do not insert/remove
        // characters because WhatsApp expects the original 8-character code.
        console.log(`🔑 Pairing code generated: ${code}`);
        return res.json({ ok: true, code });

    } catch (error) {
        console.error('Pairing error:', error?.stack || error);
        return res.status(500).json({
            ok: false,
            error: error?.message || 'Failed to generate pairing code.'
        });
    }
});

export default router;
