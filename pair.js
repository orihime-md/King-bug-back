import express from 'express';

const router = express.Router();
let controller = null;
const activePairings = new Map();
const pairingByNumber = new Map();
const MAX_PAIRING_RECORDS = 100;

const withTimeout = (promise, ms, message) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
]);

export function setPairingController(nextController) {
    controller = nextController;
}

function normalizeNumber(value) {
    return String(value || '').replace(/\D/g, '');
}

function newPairingId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function trimPairingHistory() {
    if (activePairings.size <= MAX_PAIRING_RECORDS) return;
    for (const [id, pairing] of activePairings) {
        if (activePairings.size <= MAX_PAIRING_RECORDS) break;
        if (pairing.status === 'failed' || pairing.status === 'closed' || pairing.status === 'logged_out' || pairing.status === 'open') {
            activePairings.delete(id);
            if (pairingByNumber.get(pairing.number) === id && pairing.status !== 'open') {
                pairingByNumber.delete(pairing.number);
            }
        }
    }
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
    if (typeof controller?.startPairing !== 'function') {
        return res.status(503).json({ ok: false, error: 'WhatsApp connection manager is not ready yet.' });
    }
    if (pairingByNumber.has(number)) {
        const existingId = pairingByNumber.get(number);
        const existing = activePairings.get(existingId);
        if (existing && !['failed', 'closed', 'logged_out'].includes(existing.status)) {
            return res.status(409).json({
                ok: false,
                error: `A pairing session for this number is already ${existing.status}.`,
                pairingId: existingId
            });
        }
    }

    const id = newPairingId();
    const pairing = {
        id,
        number,
        status: 'requesting',
        code: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        error: null
    };
    activePairings.set(id, pairing);
    pairingByNumber.set(number, id);
    trimPairingHistory();
    console.log(`🟡 Pairing session ${id} created for ${number}`);

    try {
        const code = await withTimeout(
            controller.startPairing(number, id),
            90_000,
            'Pairing code request timed out. The WhatsApp connection is being refreshed; try again.'
        );
        const current = activePairings.get(id);
        if (!current) return res.status(409).json({ ok: false, error: 'Pairing request expired.' });

        current.code = String(code || '').trim().toUpperCase();
        if (!current.code) throw new Error('WhatsApp did not return a pairing code.');
        current.status = 'code_ready';
        current.updatedAt = Date.now();
        console.log(`🔑 Pairing code generated for session ${id}.`);

        return res.json({
            ok: true,
            pairingId: id,
            code: current.code,
            status: current.status,
            statusUrl: `/api/pair/status?id=${encodeURIComponent(id)}`
        });
    } catch (error) {
        console.error('❌ Pairing error:', error?.stack || error);
        pairing.status = 'failed';
        pairing.error = error?.message || 'Pairing failed.';
        pairing.updatedAt = Date.now();
        if (pairingByNumber.get(number) === id) pairingByNumber.delete(number);
        return res.status(500).json({ ok: false, error: pairing.error });
    }
});

router.get('/api/pair/status', (req, res) => {
    const id = String(req.query.id || '');
    const pairing = activePairings.get(id);
    if (!id || !pairing) {
        return res.status(404).json({ ok: false, error: 'Pairing session not found or expired.' });
    }

    return res.json({
        ok: true,
        pairingId: pairing.id,
        status: pairing.status,
        code: pairing.code,
        error: pairing.error,
        ageSeconds: Math.floor((Date.now() - pairing.createdAt) / 1000),
        updatedSecondsAgo: Math.floor((Date.now() - pairing.updatedAt) / 1000)
    });
});

// Called by sever.js when one particular WhatsApp socket changes state.
export function updatePairingStatus(status, details = {}, pairingId = '') {
    if (!pairingId) return;
    const pairing = activePairings.get(pairingId);
    if (!pairing) return;

    pairing.status = status;
    pairing.updatedAt = Date.now();
    if (details.code) pairing.code = details.code;
    if (details.error) pairing.error = details.error;

    if (status === 'open') {
        console.log(`🟢 Pairing session ${pairing.id} completed.`);
    }
    if (status === 'failed' || status === 'closed' || status === 'logged_out') {
        console.log(`🔴 Pairing session ${pairing.id}: ${status}`);
        if (pairingByNumber.get(pairing.number) === pairing.id) pairingByNumber.delete(pairing.number);
    }
}

export function getActivePairing(id) {
    return activePairings.get(String(id || '')) || null;
}

export default router;
