import express from 'express';
import { firestore } from '../config/firebase.js';
import { searchLead, sendToClay } from '../services/leadWebhook.js';
import { processInstantlyWebhookEvent } from '../services/instantlyState.js';
import { upsertLead } from '../services/leads.js';

const router = express.Router();

function pickClayWebhook(userData = {}, clientData = {}) {
    // Prefer user-level webhook if present; fall back to client-level if available
    return userData.clay_webhook_url
        || userData.clayWebhookUrl
        || clientData.clay_webhook_url
        || clientData.clayWebhookUrl
        || clientData.clay_webhook
        || '';
}

async function handleLeadWebhookEvent(req, res) {
    const { userId, clientId } = req.params;

    // Dev visibility: log incoming payload and headers for debugging
    console.log('[lead-webhook][incoming]', {
        params: req.params,
        query: req.query,
        headers: req.headers,
        body: req.body
    });

    const body = req.body || {};
    const email =
        (typeof body.email === 'string' && body.email) ||
        (typeof body.lead_email === 'string' && body.lead_email) ||
        (typeof body.leadEmail === 'string' && body.leadEmail) ||
        (typeof body.recipient === 'string' && body.recipient) ||
        (typeof body.to === 'string' && body.to) ||
        '';
    const domainFromPayload = (typeof body.Domain === 'string' && body.Domain) || (typeof body.domain === 'string' && body.domain) || '';

    const nameFromParts = [body.firstName, body.first_name, body.firstname, body.lastName, body.last_name, body.lastname]
        .filter((v) => typeof v === 'string' && v.trim())
        .join(' ')
        .trim();
    const name =
        (typeof body.name === 'string' && body.name) ||
        (nameFromParts && nameFromParts) ||
        (typeof body.BrandName === 'string' && body.BrandName) ||
        (typeof body.company === 'string' && body.company) ||
        (typeof body.Domain === 'string' && body.Domain) ||
        (typeof body.domain === 'string' && body.domain) ||
        'Unknown';

    // If no usable email, return payload for inspection without erroring
    if (!email || !email.includes('@')) {
        return res.status(200).json({
            message: 'Received payload (email missing or invalid, dev passthrough)',
            received: {
                params: req.params,
                query: req.query,
                body: req.body
            }
        });
    }

    // Instantly does not send callback URLs; generate one based on the incoming host/proto
    const inferredCallbackUrl = (() => {
        const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString();
        const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
        if (!host) return null;
        return `${proto}://${host}/webhook/clay-result/${userId}/${clientId}`;
    })();

    const log = (msg, extra) => {
        if (!msg) return;
        console.log(`[lead-webhook][${userId}/${clientId}] ${msg}`, extra || '');
    };

    try {
        const userSnap = await firestore.collection('users').doc(userId).get();
        if (!userSnap.exists) {
            return res.status(404).json({ error: 'User not found.' });
        }
        const userData = userSnap.data() || {};
        const serperKey = (userData.serper_key || '').toString();
        const openaiKey = (userData.openai_key || '').toString();
        const openaiModel = (userData.openai_founder_model || '').toString() || undefined;

        if (!serperKey) {
            return res.status(400).json({ error: 'User is missing Serper API key.' });
        }

        const clientRef = firestore.collection('users').doc(userId).collection('clients').doc(clientId);
        const clientSnap = await clientRef.get();
        if (!clientSnap.exists) {
            return res.status(404).json({ error: 'Client not found.' });
        }
        const clientData = clientSnap.data() || {};
        const clayWebhookUrl = pickClayWebhook(userData, clientData);

        let searchResult;
        try {
            searchResult = await searchLead({
                name,
                email,
                serperKey,
                openaiKey,
                openaiModel,
                logger: log
            });
        } catch (err) {
            console.error(`[lead-webhook][${userId}/${clientId}] search error`, err?.message || err);
            return res.status(500).json({ error: 'Lead search failed.' });
        }

        let clayResult = { sent: false, reason: 'No LinkedIn URL found.' };
        if (searchResult?.url) {
            try {
                clayResult = await sendToClay({
                    webhookUrl: clayWebhookUrl,
                    linkedinUrl: searchResult.url,
                    name,
                    email,
                    domain: domainFromPayload || searchResult?.domain || null,
                    callbackUrl: inferredCallbackUrl,
                    logger: log
                });
            } catch (err) {
                console.error(`[lead-webhook][${userId}/${clientId}] Clay send error`, err?.message || err);
                clayResult = { sent: false, error: 'Failed to send to Clay.' };
            }
        } else if (clayWebhookUrl) {
            clayResult = { sent: false, reason: 'LinkedIn URL missing; skipped Clay.' };
        } else {
            clayResult = { sent: false, reason: 'Clay webhook URL not configured for client.' };
        }

        return res.json({
            message: 'ok',
            data: searchResult,
            clay: clayResult
        });
    } catch (error) {
        console.error(`[lead-webhook][${userId}/${clientId}] unexpected error`, error);
        return res.status(500).json({ error: 'Unhandled server error.' });
    }
}

router.post('/webhook/events/:userId/:clientId', handleLeadWebhookEvent);
router.post('/events/:userId/:clientId', handleLeadWebhookEvent);

function handleClayResult(req, res) {
    const { userId, clientId } = req.params;
    const body = req.body || {};
    const data = body.data || body;
    const name = data?.name;
    const email = data?.email;
    const phone = data?.phone;
    const domainFromPayload = data?.domain || data?.Domain || null;

    if (!name || !email) {
        return res.status(400).json({ error: 'Missing name or email.' });
    }

    const payload = { email, name, phone: phone || null };
    console.log(`[clay-callback][${userId}/${clientId}]`, payload);

    // Persist phone to the lead doc (keyed by domain) for this client
    const domain = domainFromPayload
        ? String(domainFromPayload).toLowerCase()
        : (typeof email === 'string' && email.includes('@') ? email.split('@')[1].toLowerCase() : null);
    if (domain) {
        upsertLead(userId, clientId, domain, {
            email,
            name,
            phone: phone || null
        }).catch((err) => {
            console.warn(`[clay-callback][${userId}/${clientId}] failed to upsert lead phone`, err?.message || err);
        });
    } else {
        console.warn(`[clay-callback][${userId}/${clientId}] missing domain for lead; skipped phone upsert`);
    }

    return res.json(payload);
}

router.post('/webhook/clay-result/:userId/:clientId', handleClayResult);
router.post('/clay-result/:userId/:clientId', handleClayResult);

async function handleInstantlyWebhookEvent(req, res) {
    const { userId, clientId } = req.params;
    const secret = (req.headers['x-shields-webhook-secret'] || '').toString().trim();

    try {
        const result = await processInstantlyWebhookEvent({
            agencyId: userId,
            clientSlug: clientId,
            secret,
            event: req.body || {},
            logger: (message) => console.log(`[instantly-webhook][${userId}/${clientId}] ${message}`)
        });
        return res.status(202).json({ ok: true, ...result });
    } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        console.error(`[instantly-webhook][${userId}/${clientId}] failed:`, error?.message || error);
        return res.status(statusCode).json({ error: error?.message || 'Failed to process Instantly webhook event.' });
    }
}

router.post('/webhook/instantly/events/:userId/:clientId', handleInstantlyWebhookEvent);
router.post('/instantly/events/:userId/:clientId', handleInstantlyWebhookEvent);

export default router;
