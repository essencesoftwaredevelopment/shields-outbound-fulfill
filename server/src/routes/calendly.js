/**
 * Public Calendly availability + booking for the essence-retention client.
 * Uses the shared CALENDLY_PAT (same token the webhook uses to enrich bookings).
 */
import express from 'express';
import { resolveClientRow } from '../services/db/queries.js';
import {
    ESSENCE_RETENTION_AGENCY_ID,
    isEssenceRetentionClient
} from '../services/resendScope.js';
import { listEventTypeAvailableTimes } from '../services/calendlyAvailability.js';
import { bookEventInvitee } from '../services/calendlyBooking.js';

const router = express.Router();

function setNoStoreHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
}

function sendError(res, error, fallback) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) {
        console.error(fallback, error?.message || error);
    }
    const message = error?.statusCode && error?.message
        ? error.message
        : (status >= 500 ? fallback : (error?.message || fallback));
    const payload = { error: message };
    if (error?.details) payload.details = error.details;
    res.status(status).json(payload);
}

async function requireEssenceRetentionClient(clientId) {
    const clientRow = await resolveClientRow(ESSENCE_RETENTION_AGENCY_ID, clientId);
    if (!clientRow) return { error: { status: 404, message: 'Client not found.' } };
    if (!isEssenceRetentionClient({
        agencyId: clientRow.agency_id,
        clientSlug: clientRow.slug
    })) {
        return { error: { status: 403, message: 'Calendly is only available for essence-retention.' } };
    }
    return { clientRow };
}

router.get('/clients/:clientId/calendly/available-times', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const scoped = await requireEssenceRetentionClient(req.params.clientId);
        if (scoped.error) return res.status(scoped.error.status).json({ error: scoped.error.message });

        const result = await listEventTypeAvailableTimes({
            eventType: req.query.eventType || req.query.event_type,
            startTime: req.query.startTime || req.query.start_time,
            endTime: req.query.endTime || req.query.end_time
        });
        res.json(result);
    } catch (error) {
        sendError(res, error, 'Failed to load Calendly available times.');
    }
});

router.post('/clients/:clientId/calendly/book', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const scoped = await requireEssenceRetentionClient(req.params.clientId);
        if (scoped.error) return res.status(scoped.error.status).json({ error: scoped.error.message });

        const result = await bookEventInvitee({ body: req.body || {} });
        res.status(201).json(result);
    } catch (error) {
        sendError(res, error, 'Failed to book Calendly event.');
    }
});

export default router;
