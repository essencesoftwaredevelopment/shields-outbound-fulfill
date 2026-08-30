/**
 * Deal Flow routes — kanban board of interested leads per client.
 *
 * Every route: requireAuth → resolveClientRow(req.agencyId, :clientId) → 404,
 * and every query is additionally scoped by client_id. Same shape as
 * POST /leads/:contactId/instantly-interest-status.
 */
import express from 'express';
import { verifyFirebaseToken as requireAuth } from '../middleware/auth.js';
import { resolveClientRow } from '../services/db/queries.js';
import { loadBoard, updateDeal, createDeal, archiveDeal, saveStages } from '../services/db/dealFlow.js';

const router = express.Router();

function setNoStoreHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
}

function actorFor(req) {
    const email = String(req.auth?.email || '').trim();
    return email ? `user:${email}` : `user:${req.agencyId}`;
}

function sendError(res, error, fallback) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) {
        console.error(fallback, error?.message || error);
    }
    res.status(status).json({ error: status >= 500 ? fallback : (error?.message || fallback) });
}

function parseId(value) {
    const n = Number.parseInt(String(value), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

router.get('/clients/:clientId/deal-flow', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });
        const closedSinceDays = Number.parseInt(String(req.query.closedSinceDays || '60'), 10);
        const board = await loadBoard(clientRow, { closedSinceDays });
        res.json(board);
    } catch (error) {
        sendError(res, error, 'Failed to load deal flow.');
    }
});

router.patch('/clients/:clientId/deal-flow/deals/:dealId', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });
        const dealId = parseId(req.params.dealId);
        if (!dealId) return res.status(400).json({ error: 'Valid dealId is required.' });

        const body = req.body || {};
        const patch = {};
        if (body.stageId !== undefined) {
            const stageId = parseId(body.stageId);
            if (!stageId) return res.status(400).json({ error: 'stageId must be a positive integer.' });
            patch.stageId = stageId;
        }
        if (body.position !== undefined) {
            const position = Number(body.position);
            if (!Number.isFinite(position)) return res.status(400).json({ error: 'position must be a number.' });
            patch.position = position;
        }
        if (body.notes !== undefined) {
            if (body.notes !== null && typeof body.notes !== 'string') {
                return res.status(400).json({ error: 'notes must be a string.' });
            }
            patch.notes = body.notes === null ? null : body.notes.slice(0, 20000);
        }
        if (body.nextActionAt !== undefined) {
            if (body.nextActionAt === null || body.nextActionAt === '') {
                patch.nextActionAt = null;
            } else {
                const date = new Date(body.nextActionAt);
                if (Number.isNaN(date.getTime())) return res.status(400).json({ error: 'nextActionAt must be a date.' });
                patch.nextActionAt = date.toISOString();
            }
        }
        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ error: 'Nothing to update.' });
        }

        const deal = await updateDeal(clientRow, dealId, patch, { actor: actorFor(req) });
        if (!deal) return res.status(404).json({ error: 'Deal not found.' });
        res.json({ deal });
    } catch (error) {
        sendError(res, error, 'Failed to update deal.');
    }
});

router.post('/clients/:clientId/deal-flow/deals', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });
        const contactId = parseId(req.body?.contactId);
        if (!contactId) return res.status(400).json({ error: 'contactId is required.' });
        const campaignId = req.body?.campaignId ? parseId(req.body.campaignId) : null;
        const stageId = req.body?.stageId ? parseId(req.body.stageId) : null;
        const deal = await createDeal(clientRow, { contactId, campaignId, stageId }, { actor: actorFor(req) });
        res.status(201).json({ deal });
    } catch (error) {
        sendError(res, error, 'Failed to add deal.');
    }
});

router.delete('/clients/:clientId/deal-flow/deals/:dealId', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });
        const dealId = parseId(req.params.dealId);
        if (!dealId) return res.status(400).json({ error: 'Valid dealId is required.' });
        const ok = await archiveDeal(clientRow, dealId);
        if (!ok) return res.status(404).json({ error: 'Deal not found.' });
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error, 'Failed to remove deal.');
    }
});

router.put('/clients/:clientId/deal-flow/stages', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });
        const stagesIn = Array.isArray(req.body?.stages) ? req.body.stages : null;
        if (!stagesIn) return res.status(400).json({ error: 'stages must be an array.' });
        const stages = stagesIn.map((s) => ({
            id: s?.id ? parseId(s.id) : null,
            name: typeof s?.name === 'string' ? s.name.slice(0, 80) : '',
            kind: typeof s?.kind === 'string' ? s.kind : 'open',
            color: typeof s?.color === 'string' ? s.color : 'slate',
            isEntry: Boolean(s?.isEntry)
        }));
        const deletions = (Array.isArray(req.body?.deletions) ? req.body.deletions : []).map((d) => ({
            id: parseId(d?.id),
            moveDealsTo: parseId(d?.moveDealsTo)
        })).filter((d) => d.id);
        const result = await saveStages(clientRow, { stages, deletions }, { actor: actorFor(req) });
        res.json({ stages: result });
    } catch (error) {
        sendError(res, error, 'Failed to save stages.');
    }
});

export default router;
