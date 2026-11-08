/**
 * Metrics tab routes: the funnel report plus the manual inputs behind it
 * (sales log, outreach cost lines). Migration 0075.
 *
 * Every route: requireAuth → resolveClientRow(req.agencyId, :clientId) → 404,
 * and every query is additionally scoped by agency_id + client_id.
 */
import express from 'express';
import { verifyFirebaseToken as requireAuth } from '../middleware/auth.js';
import { resolveClientRow } from '../services/db/queries.js';
import { loadFunnelMetrics } from '../services/funnelMetrics.js';
import {
    CALL_STATUSES,
    OUTCOMES,
    LOST_REASONS,
    COST_CATEGORIES,
    syncCalendlyBookings,
    listSalesCalls,
    createSalesCall,
    updateSalesCall,
    deleteSalesCall,
    listOutreachCosts,
    createOutreachCost,
    updateOutreachCost,
    deleteOutreachCost
} from '../services/db/funnelInputs.js';
import { getCallRecordingStatus, linkFathomCall } from '../services/callAnalysis/index.js';

const router = express.Router();

function setNoStoreHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
}

function sendError(res, error, fallback) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error(fallback, error?.message || error);
    res.status(status).json({ error: status >= 500 ? fallback : (error?.message || fallback) });
}

function parseId(value) {
    const n = Number.parseInt(String(value), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
}

async function requireClient(req, res) {
    const clientRow = await resolveClientRow(req.agencyId, req.params.clientId);
    if (!clientRow) res.status(404).json({ error: 'Client not found.' });
    return clientRow;
}

router.get('/clients/:clientId/metrics', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await requireClient(req, res);
        if (!clientRow) return;
        res.json(await loadFunnelMetrics({ clientRow, periodKey: String(req.query.period || '7d') }));
    } catch (error) {
        sendError(res, error, 'Failed to load metrics.');
    }
});

router.get('/clients/:clientId/metrics/sales-calls', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await requireClient(req, res);
        if (!clientRow) return;
        await syncCalendlyBookings(clientRow);
        res.json({
            calls: await listSalesCalls(clientRow),
            options: { callStatuses: CALL_STATUSES, outcomes: OUTCOMES, lostReasons: LOST_REASONS }
        });
    } catch (error) {
        sendError(res, error, 'Failed to load the sales log.');
    }
});

router.post('/clients/:clientId/metrics/sales-calls', requireAuth, async (req, res) => {
    try {
        const clientRow = await requireClient(req, res);
        if (!clientRow) return;
        res.status(201).json({ call: await createSalesCall(clientRow, req.body || {}) });
    } catch (error) {
        sendError(res, error, 'Failed to add the call.');
    }
});

router.patch('/clients/:clientId/metrics/sales-calls/:id', requireAuth, async (req, res) => {
    try {
        const clientRow = await requireClient(req, res);
        if (!clientRow) return;
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Valid id is required.' });
        const call = await updateSalesCall(clientRow, id, req.body || {});
        if (!call) return res.status(404).json({ error: 'Call not found.' });
        res.json({ call });
    } catch (error) {
        sendError(res, error, 'Failed to save the call.');
    }
});

router.delete('/clients/:clientId/metrics/sales-calls/:id', requireAuth, async (req, res) => {
    try {
        const clientRow = await requireClient(req, res);
        if (!clientRow) return;
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Valid id is required.' });
        if (!await deleteSalesCall(clientRow, id)) return res.status(404).json({ error: 'Call not found.' });
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error, 'Failed to delete the call.');
    }
});

/** Add a Fathom call by its link; body { url, salesCallId? } (no salesCallId = match or create). */
router.post('/clients/:clientId/metrics/fathom-calls', requireAuth, async (req, res) => {
    try {
        const clientRow = await requireClient(req, res);
        if (!clientRow) return;
        const salesCallId = req.body?.salesCallId === undefined || req.body?.salesCallId === null
            ? null
            : parseId(req.body.salesCallId);
        if (req.body?.salesCallId != null && !salesCallId) return res.status(400).json({ error: 'Valid salesCallId is required.' });
        res.status(202).json(await linkFathomCall({
            agencyId: req.agencyId,
            clientRow,
            url: req.body?.url,
            salesCallId
        }));
    } catch (error) {
        sendError(res, error, 'Failed to add the Fathom call.');
    }
});

router.get('/clients/:clientId/metrics/fathom-calls/:recordingId', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await requireClient(req, res);
        if (!clientRow) return;
        const recordingId = parseId(req.params.recordingId);
        if (!recordingId) return res.status(400).json({ error: 'Valid recording id is required.' });
        const recording = await getCallRecordingStatus({ agencyId: req.agencyId, clientId: clientRow.id, recordingId });
        if (!recording) return res.status(404).json({ error: 'Recording not found.' });
        res.json({ recording });
    } catch (error) {
        sendError(res, error, 'Failed to load the call status.');
    }
});

router.get('/clients/:clientId/metrics/costs', requireAuth, async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await requireClient(req, res);
        if (!clientRow) return;
        res.json({ costs: await listOutreachCosts(clientRow), options: { categories: COST_CATEGORIES } });
    } catch (error) {
        sendError(res, error, 'Failed to load outreach costs.');
    }
});

router.post('/clients/:clientId/metrics/costs', requireAuth, async (req, res) => {
    try {
        const clientRow = await requireClient(req, res);
        if (!clientRow) return;
        res.status(201).json({ cost: await createOutreachCost(clientRow, req.body || {}) });
    } catch (error) {
        sendError(res, error, 'Failed to add the cost.');
    }
});

router.patch('/clients/:clientId/metrics/costs/:id', requireAuth, async (req, res) => {
    try {
        const clientRow = await requireClient(req, res);
        if (!clientRow) return;
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Valid id is required.' });
        const cost = await updateOutreachCost(clientRow, id, req.body || {});
        if (!cost) return res.status(404).json({ error: 'Cost not found.' });
        res.json({ cost });
    } catch (error) {
        sendError(res, error, 'Failed to save the cost.');
    }
});

router.delete('/clients/:clientId/metrics/costs/:id', requireAuth, async (req, res) => {
    try {
        const clientRow = await requireClient(req, res);
        if (!clientRow) return;
        const id = parseId(req.params.id);
        if (!id) return res.status(400).json({ error: 'Valid id is required.' });
        if (!await deleteOutreachCost(clientRow, id)) return res.status(404).json({ error: 'Cost not found.' });
        res.json({ ok: true });
    } catch (error) {
        sendError(res, error, 'Failed to delete the cost.');
    }
});

export default router;
