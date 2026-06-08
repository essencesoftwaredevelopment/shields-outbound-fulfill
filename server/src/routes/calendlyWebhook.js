import express from 'express';
import { env } from '../config/env.js';
import {
    processCalendlyWebhook,
    verifyCalendlySignature
} from '../services/calendlyWebhook.js';

const router = express.Router();

router.post('/', async (req, res) => {
    const startMs = Date.now();
    const rawBody = req.body;
    const signatureHeader = req.headers['calendly-webhook-signature'];
    const deliveryId = req.headers['calendly-webhook-delivery-id']
        || req.headers['calendly-webhook-delivery']
        || null;

    const verification = verifyCalendlySignature(
        rawBody,
        typeof signatureHeader === 'string' ? signatureHeader : null,
        env.CALENDLY_WEBHOOK_SECRET
    );

    if (!verification.valid) {
        console.warn('[calendly-webhook] signature verification failed:', verification.reason);
        return res.status(401).json({ error: 'Invalid webhook signature.' });
    }

    let body;
    try {
        const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
        body = JSON.parse(bodyText);
    } catch {
        return res.status(400).json({ error: 'Invalid JSON payload.' });
    }

    try {
        const result = await processCalendlyWebhook({
            body,
            deliveryId: typeof deliveryId === 'string' ? deliveryId : null,
            pat: env.CALENDLY_PAT
        });
        return res.status(200).json({ ok: true, ...result, duration_ms: Date.now() - startMs });
    } catch (error) {
        console.error('[calendly-webhook] processing error:', error?.message || error);
        return res.status(500).json({ error: 'Failed to process Calendly webhook.' });
    }
});

export default router;
