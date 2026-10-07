import express from 'express';

const router = express.Router();

let whatsappSocket = null;
let socketStateGetter = null;

export function setPairingSocket(sock, state = {}) {
    whatsappSocket = sock;
    socketStateGetter = typeof state.getState === 'function'
        ? state.getState
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

        // Give Render/Baileys a short window to finish creating the socket.
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

        // Pairing-code login is only for an unregistered auth state.
        if (sock.authState?.creds?.registered) {
            return res.status(409).json({
                ok: false,
                error: 'This WhatsApp session is already registered. Remove the existing auth session before pairing a new number.'
            });
        }

        console.log(`🔐 Pairing code requested for ${number}`);
        const rawCode = await sock.requestPairingCode(number);

        const cleanCode = String(rawCode || '')
            .replace(/[^A-Za-z0-9]/g, '')
            .toUpperCase();

        if (!cleanCode) {
            return res.status(502).json({
                ok: false,
                error: 'WhatsApp did not return a pairing code.'
            });
        }

        const code = cleanCode.length === 8
            ? `${cleanCode.slice(0, 4)}-${cleanCode.slice(4)}`
            : cleanCode;

        console.log(`🔑 Pairing code generated: ${code}`);
        return res.json({ ok: true, code });

    } catch (error) {
        console.error('Pairing error:', error);
        return res.status(500).json({
            ok: false,
            error: error?.message || 'Failed to generate pairing code.'
        });
    }
});

export default router;
