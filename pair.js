import express from 'express';

const router = express.Router();

let whatsappSocket = null;
let socketState = 'connecting';
let socketWaiters = [];

export function setPairingSocket(sock) {
    whatsappSocket = sock;
    socketState = 'connecting';

    sock.ev.on('connection.update', ({ connection }) => {
        if (connection) socketState = connection;
        if (connection === 'open' || connection === 'close') {
            const waiters = socketWaiters.splice(0);
            for (const resolve of waiters) resolve();
        }
    });
}

function waitForSocket(maxMs = 15000) {
    if (whatsappSocket && socketState !== 'close') return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            socketWaiters = socketWaiters.filter(r => r !== done);
            resolve();
        }, maxMs);
        const done = () => { clearTimeout(timer); resolve(); };
        socketWaiters.push(done);
    });
}

router.get('/api/pair', async (req, res) => {
    try {
        const number = String(req.query.number || '').replace(/\D/g, '');

        if (!number) {
            return res.status(400).json({
                ok: false,
                error: 'Phone number is required.'
            });
        }

        if (number.length < 10 || number.length > 15) {
            return res.status(400).json({
                ok: false,
                error: 'Invalid phone number.'
            });
        }

        await waitForSocket();

        if (!whatsappSocket || socketState === 'close') {
            return res.status(503).json({
                ok: false,
                error: 'WhatsApp connection is reconnecting. Try again in a few seconds.'
            });
        }

        if (whatsappSocket.authState?.creds?.registered) {
            return res.status(409).json({
                ok: false,
                error: 'This session is already paired. Clear the auth session before pairing a new number.'
            });
        }

        const rawCode = await whatsappSocket.requestPairingCode(number);

        const cleanCode = String(rawCode || '')
            .replace(/[^A-Za-z0-9]/g, '')
            .toUpperCase();

        const code = cleanCode.length === 8
            ? `${cleanCode.slice(0, 4)}-${cleanCode.slice(4)}`
            : cleanCode;

        return res.json({
            ok: true,
            code
        });

    } catch (error) {
        console.error('Pairing error:', error);

        return res.status(500).json({
            ok: false,
            error: error.message || 'Failed to generate pairing code.'
        });
    }
});

export default router;
