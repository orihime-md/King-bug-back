import express from 'express';

const router = express.Router();

let controller = null;
let activePairing = null;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function setPairingController(nextController) {
    controller = nextController;
}

// Backward-compatible name for the existing King Bug code.
export function setPairingSocket(sock, state = {}) {
    controller = {
        getSocket: () => sock,
        getState: state.getState,
        getRegistered: state.getRegistered,
        waitUntilReady: state.waitUntilReady,
        requestPairingCode: state.requestPairingCode
    };
}

function normalizeNumber(value) {
    return String(value || '').replace(/\D/g, '');
}

function newPairingId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

router.get('/api/pair', async (req, res) => {
    const number = normalizeNumber(req.query.number);

    if (!number) {
        return res.status(400).json({ ok: false, error: 'Phone number is required.' });
    }

    if (number.length < 10 || number.length > 15) {
        return res.status(400).json({
            ok: false,
            error: 'Invalid phone number. Use country code and digits only.'
        });
    }

    if (!controller?.getSocket) {
        return res.status(503).json({
            ok: false,
            error: 'WhatsApp connection manager is not ready yet.'
        });
    }

    try {
        const registered = typeof controller.getRegistered === 'function'
            ? controller.getRegistered()
            : false;

        if (registered) {
            return res.status(409).json({
                ok: false,
                error: 'This session is already registered. Remove the auth session before pairing another number.'
            });
        }

        const id = newPairingId();
        activePairing = {
            id,
            number,
            status: 'waiting',
            code: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            error: null
        };

        console.log(`🟡 Pairing session ${id} created for ${number}`);

        // The important part: do not call requestPairingCode immediately after
        // makeWASocket(). Wait for Baileys' QR/ready event first.
        if (typeof controller.waitUntilReady === 'function') {
            await controller.waitUntilReady(30000);
        }

        if (!activePairing || activePairing.id !== id) {
            return res.status(409).json({ ok: false, error: 'Pairing request was replaced.' });
        }

        activePairing.status = 'requesting';
        activePairing.updatedAt = Date.now();

        const code = await controller.requestPairingCode(number);

        if (!code) {
            throw new Error('WhatsApp did not return a pairing code.');
        }

        activePairing.code = String(code).trim().toUpperCase();
        activePairing.status = 'code_ready';
        activePairing.updatedAt = Date.now();

        console.log(`🔑 Pairing code generated for session ${id}: ${activePairing.code}`);

        return res.json({
            ok: true,
            pairingId: id,
            code: activePairing.code,
            status: activePairing.status,
            statusUrl: `/api/pair/status?id=${encodeURIComponent(id)}`
        });
    } catch (error) {
        console.error('❌ Pairing error:', error?.stack || error);

        if (activePairing) {
            activePairing.status = 'failed';
            activePairing.error = error?.message || 'Pairing failed.';
            activePairing.updatedAt = Date.now();
        }

        return res.status(500).json({
            ok: false,
            error: error?.message || 'Failed to generate pairing code.'
        });
    }
});

router.get('/api/pair/status', (req, res) => {
    const id = String(req.query.id || '');

    if (!id || !activePairing || activePairing.id !== id) {
        return res.status(404).json({
            ok: false,
            error: 'Pairing session not found or expired.'
        });
    }

    return res.json({
        ok: true,
        pairingId: activePairing.id,
        status: activePairing.status,
        code: activePairing.code,
        error: activePairing.error,
        ageSeconds: Math.floor((Date.now() - activePairing.createdAt) / 1000)
    });
});

// Called by sever.js when the WhatsApp socket changes state.
export function updatePairingStatus(status, details = {}) {
    if (!activePairing) return;

    activePairing.status = status;
    activePairing.updatedAt = Date.now();

    if (details.code) activePairing.code = details.code;
    if (details.error) activePairing.error = details.error;

    if (status === 'open') {
        console.log(`🟢 Pairing session ${activePairing.id} completed.`);
    }

    if (status === 'failed' || status === 'closed' || status === 'logged_out') {
        console.log(`🔴 Pairing session ${activePairing.id}: ${status}`);
    }
}

export function getActivePairing() {
    return activePairing;
}

export default router;
