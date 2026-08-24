import express from 'express';
import { env } from '../config/env.js';
import {
    processResendWebhook,
    verifyResendSignature
} from '../services/resendWebhook.js';

const router = express.Router();

router.post('/', async (req, res) => {
    const startMs = Date.now();
    const rawBody = req.body;
    const svixId = req.headers['svix-id'] || null;

    const verification = verifyResendSignature(
        rawBody,
        req.headers,
        env.RESEND_WEBHOOK_SECRET
    );

    if (!verification.valid) {
        console.warn('[resend-webhook] signature verification failed:', verification.reason);
        return res.status(401).json({ error: 'Invalid webhook signature.' });
    }

    if (verification.skipped) {
        console.warn('[resend-webhook] signature verification skipped (RESEND_WEBHOOK_SECRET not set)');
    }

    let body;
    try {
        const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
        body = JSON.parse(bodyText);
    } catch {
        return res.status(400).json({ error: 'Invalid JSON payload.' });
    }

    try {
        const result = await processResendWebhook({
            body,
            svixId: typeof svixId === 'string' ? svixId : null,
            logger: (message) => console.log(`[resend-webhook] ${message}`)
        });
        return res.status(200).json({ ok: true, ...result, duration_ms: Date.now() - startMs });
    } catch (error) {
        console.error('[resend-webhook] processing error:', error?.message || error);
        return res.status(500).json({ error: 'Failed to process Resend webhook.' });
    }
});

export default router;
