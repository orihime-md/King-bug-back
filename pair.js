import express from 'express';

const router = express.Router();

let whatsappSocket = null;

export function setPairingSocket(sock) {
    whatsappSocket = sock;
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

        if (!whatsappSocket) {
            return res.status(503).json({
                ok: false,
                error: 'WhatsApp connection is not ready.'
            });
        }

        const rawCode =
            await whatsappSocket.requestPairingCode(number);

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
