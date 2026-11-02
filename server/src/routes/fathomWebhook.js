/**
 * POST /webhooks/fathom/:agencyId — Fathom "new meeting content ready".
 * Registered per agency by connectFathom (services/callAnalysis) when a Fathom
 * key is saved; verified with that agency's webhook secret. Stores the
 * recording and starts the call-analysis workflow; Fathom gets a 200 straight
 * away so slow analysis never causes a redelivery.
 */
import express from 'express';
import { getAgencySettings } from '../services/db/agencySettings.js';
import { verifyFathomSignature } from '../services/fathom.js';
import { ingestFathomMeeting, triggerCallAnalysis } from '../services/callAnalysis/index.js';

const router = express.Router();

router.post('/:agencyId', async (req, res) => {
    const agencyId = String(req.params.agencyId || '').trim();
    const settings = agencyId ? await getAgencySettings(agencyId).catch(() => null) : null;
    const verification = verifyFathomSignature({
        rawBody: req.body,
        headers: req.headers,
        secret: settings?.fathom_webhook_secret
    });
    if (!verification.valid) {
        console.warn(`[fathom-webhook] rejected agency=${agencyId}: ${verification.reason}`);
        return res.status(401).json({ error: 'Invalid webhook signature.' });
    }

    let meeting;
    try {
        const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
        meeting = JSON.parse(text);
    } catch {
        return res.status(400).json({ error: 'Invalid JSON payload.' });
    }

    try {
        const { recordingId, needsAnalysis } = await ingestFathomMeeting(agencyId, meeting);
        res.status(200).json({ ok: true, recordingId, queued: needsAnalysis });
        if (needsAnalysis) {
            triggerCallAnalysis({ recordingId, agencyId }).catch((error) => {
                console.error(`[fathom-webhook] analysis failed recording=${recordingId}:`, error?.message || error);
            });
        }
    } catch (error) {
        console.error('[fathom-webhook] processing error:', error?.message || error);
        return res.status(500).json({ error: 'Failed to process Fathom webhook.' });
    }
});

export default router;
