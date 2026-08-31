/**
 * Public Calendly availability for the essence-retention client.
 * Uses the shared CALENDLY_PAT (same token the webhook uses to enrich bookings).
 */
import express from 'express';
import { resolveClientRow } from '../services/db/queries.js';
import {
    ESSENCE_RETENTION_AGENCY_ID,
    isEssenceRetentionClient
} from '../services/resendScope.js';
import { listEventTypeAvailableTimes } from '../services/calendlyAvailability.js';

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
    res.status(status).json({ error: status >= 500 ? fallback : (error?.message || fallback) });
}

router.get('/clients/:clientId/calendly/available-times', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientRow = await resolveClientRow(ESSENCE_RETENTION_AGENCY_ID, req.params.clientId);
        if (!clientRow) return res.status(404).json({ error: 'Client not found.' });

        if (!isEssenceRetentionClient({
            agencyId: clientRow.agency_id,
            clientSlug: clientRow.slug
        })) {
            return res.status(403).json({ error: 'Calendly availability is only available for essence-retention.' });
        }

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

export default router;
