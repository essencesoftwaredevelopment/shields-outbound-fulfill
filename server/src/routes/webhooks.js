import express from 'express';
import { processInstantlyWebhookEvent, validateInstantlyWebhookSecret } from '../services/instantlyState.js';
import { processCalendlyWebhookForClient } from '../services/calendlyWebhook.js';
import { processProspectActivityWebhook } from '../services/prospectActivityWebhook.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Instantly webhook – concurrency-limited, async processing
// ---------------------------------------------------------------------------
const INSTANTLY_WEBHOOK_CONCURRENCY = Math.max(Number(process.env.INSTANTLY_WEBHOOK_CONCURRENCY || 2) || 2, 1);
let instantlyWebhookRunning = 0;
const instantlyWebhookQueue = [];

function drainInstantlyWebhookQueue() {
    while (instantlyWebhookRunning < INSTANTLY_WEBHOOK_CONCURRENCY && instantlyWebhookQueue.length > 0) {
        const task = instantlyWebhookQueue.shift();
        instantlyWebhookRunning++;
        task().finally(() => {
            instantlyWebhookRunning--;
            drainInstantlyWebhookQueue();
        });
    }
}

async function handleInstantlyWebhookEvent(req, res) {
    const { userId, clientId } = req.params;
    const secret = (req.headers['x-shields-webhook-secret'] || '').toString().trim();

    // Fast-path validation using cached client state – reject bad requests immediately
    try {
        const validation = await validateInstantlyWebhookSecret(userId, clientId, secret);
        if (!validation.valid) {
            return res.status(validation.statusCode).json({ error: validation.message });
        }
    } catch (error) {
        console.error(`[instantly-webhook][${userId}/${clientId}] validation error:`, error?.message || error);
        return res.status(500).json({ error: 'Webhook validation failed.' });
    }

    // Respond immediately – processing happens async
    res.status(202).json({ ok: true, queued: true });

    // Enqueue the actual DB work
    const event = req.body || {};
    instantlyWebhookQueue.push(() =>
        processInstantlyWebhookEvent({
            agencyId: userId,
            clientSlug: clientId,
            secret,
            event,
            logger: (message) => console.log(`[instantly-webhook][${userId}/${clientId}] ${message}`)
        }).catch((error) => {
            console.error(`[instantly-webhook][${userId}/${clientId}] failed:`, error?.message || error);
        })
    );
    drainInstantlyWebhookQueue();
}

router.post('/webhook/instantly/events/:userId/:clientId', handleInstantlyWebhookEvent);
router.post('/instantly/events/:userId/:clientId', handleInstantlyWebhookEvent);

// ---------------------------------------------------------------------------
// Calendly webhook (legacy per-client URL) – delegates to calendlyWebhook service
// ---------------------------------------------------------------------------

async function handleCalendlyWebhookEvent(req, res) {
    const { userId, clientId } = req.params;
    const body = req.body || {};

    try {
        const result = await processCalendlyWebhookForClient({
            body,
            agencyId: userId,
            clientId,
            deliveryId: req.headers['calendly-webhook-delivery-id'] || null
        });
        return res.status(200).json({ ok: true, ...result });
    } catch (error) {
        console.error(`[calendly-webhook][${userId}/${clientId}] error:`, error?.message || error);
        return res.status(500).json({ error: 'Failed to store Calendly event.' });
    }
}

router.post('/webhook/calendly/:userId/:clientId', handleCalendlyWebhookEvent);
router.post('/calendly/:userId/:clientId', handleCalendlyWebhookEvent);

// ---------------------------------------------------------------------------
// Generic prospect activity webhook – any title/description on lead timeline
// ---------------------------------------------------------------------------

async function handleProspectActivityWebhook(req, res) {
    const { userId, clientId } = req.params;
    const secret = (req.headers['x-shields-webhook-secret'] || '').toString().trim();

    try {
        const validation = await validateInstantlyWebhookSecret(userId, clientId, secret);
        if (!validation.valid) {
            return res.status(validation.statusCode).json({ error: validation.message });
        }
    } catch (error) {
        console.error(`[prospect-activity-webhook][${userId}/${clientId}] validation error:`, error?.message || error);
        return res.status(500).json({ error: 'Webhook validation failed.' });
    }

    try {
        const result = await processProspectActivityWebhook({
            agencyId: userId,
            clientSlug: clientId,
            body: req.body || {},
            logger: (message) => console.log(`[prospect-activity-webhook][${userId}/${clientId}] ${message}`)
        });
        return res.status(200).json(result);
    } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        if (statusCode >= 500) {
            console.error(`[prospect-activity-webhook][${userId}/${clientId}] error:`, error?.message || error);
        }
        return res.status(statusCode).json({
            error: error?.statusCode
                ? (error.message || 'Failed to record prospect activity.')
                : 'Failed to record prospect activity.'
        });
    }
}

router.post('/webhook/activity/:userId/:clientId', handleProspectActivityWebhook);
router.post('/activity/:userId/:clientId', handleProspectActivityWebhook);

export default router;
