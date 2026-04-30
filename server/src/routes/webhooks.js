import crypto from 'crypto';
import express from 'express';
import { firestore } from '../config/firebase.js';
import { searchLead, sendToClay } from '../services/leadWebhook.js';
import { processInstantlyWebhookEvent, validateInstantlyWebhookSecret } from '../services/instantlyState.js';
import { upsertLead } from '../services/leads.js';
import { pool } from '../lib/db.js';
import { getOrCreateClient } from '../services/db/queries.js';

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
// Calendly webhook – meeting booked events stored as contact timeline events
// ---------------------------------------------------------------------------

async function handleCalendlyWebhookEvent(req, res) {
    const { userId, clientId } = req.params;
    const body = req.body || {};

    // Calendly sends { event: 'invitee.created', payload: { ... } }
    // We store all event types but only create a timeline entry for bookings.
    const eventName = (typeof body.event === 'string' ? body.event : '') || 'invitee.created';
    const payload = (typeof body.payload === 'object' && body.payload) ? body.payload : body;

    const invitee = (typeof payload.invitee === 'object' && payload.invitee) ? payload.invitee : {};
    const scheduledEvent = (typeof payload.scheduled_event === 'object' && payload.scheduled_event)
        ? payload.scheduled_event
        : (typeof payload.event === 'object' && payload.event) ? payload.event : {};
    const eventTypeInfo = (typeof payload.event_type === 'object' && payload.event_type) ? payload.event_type : {};

    const email = [
        invitee.email,
        payload.email,
        body.email
    ].map(v => (typeof v === 'string' ? v.trim().toLowerCase() : '')).find(v => v.includes('@')) || '';

    if (!email) {
        console.warn(`[calendly-webhook][${userId}/${clientId}] missing invitee email`);
        return res.status(200).json({ ok: true, skipped: 'no invitee email in payload' });
    }

    const inviteeName = invitee.name || `${invitee.first_name || ''} ${invitee.last_name || ''}`.trim() || null;
    const meetingName = scheduledEvent.name || eventTypeInfo.name || null;
    const startTime = scheduledEvent.start_time || invitee.created_at || null;
    const inviteeUuid = invitee.uuid || null;
    const questionsAndAnswers = invitee.questions_and_answers || payload.questions_and_answers || [];

    // Map Calendly event type to a timeline event_type value
    const timelineEventType = eventName === 'invitee.canceled' ? 'meeting_canceled' : 'meeting_booked';

    // Fingerprint based on invitee UUID (unique per booking), falling back to email+start_time
    const fingerprintBase = `calendly|${inviteeUuid || email}|${startTime || ''}|${timelineEventType}`;
    const fingerprint = crypto.createHash('sha256').update(fingerprintBase).digest('hex');

    const eventTimestamp = startTime ? new Date(startTime) : new Date();
    if (isNaN(eventTimestamp.getTime())) {
        console.warn(`[calendly-webhook][${userId}/${clientId}] invalid start_time '${startTime}', using now`);
    }
    const safeTimestamp = isNaN(eventTimestamp.getTime()) ? new Date() : eventTimestamp;

    const storedPayload = {
        calendly_event: eventName,
        invitee_uuid: inviteeUuid,
        meeting_name: meetingName,
        start_time: startTime,
        end_time: scheduledEvent.end_time || null,
        timezone: invitee.timezone || null,
        cancel_url: payload.cancel_url || null,
        reschedule_url: payload.reschedule_url || null,
        questions_and_answers: questionsAndAnswers,
        raw: body
    };

    try {
        const sqlClientId = await getOrCreateClient(userId, clientId);

        // Look up the contact by email within this agency
        const contactResult = await pool.query(
            `SELECT id FROM contacts WHERE email = $1 AND agency_id = $2 LIMIT 1`,
            [email, userId]
        );
        const contactId = contactResult.rows[0]?.id || null;

        await pool.query(
            `INSERT INTO contact_instantly_events (
                agency_id, client_id, contact_id,
                event_type, lead_email,
                message_text, event_timestamp, fingerprint, source, payload
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'calendly', $9::jsonb)
            ON CONFLICT (source, fingerprint) DO NOTHING`,
            [
                userId,
                sqlClientId,
                contactId,
                timelineEventType,
                email,
                inviteeName ? `${inviteeName} booked: ${meetingName || 'meeting'}` : (meetingName || 'Meeting booked'),
                safeTimestamp,
                fingerprint,
                JSON.stringify(storedPayload)
            ]
        );

        console.log(`[calendly-webhook][${userId}/${clientId}] stored ${timelineEventType} for ${email} (contact_id=${contactId ?? 'unknown'})`);
        return res.status(200).json({ ok: true });
    } catch (error) {
        console.error(`[calendly-webhook][${userId}/${clientId}] error:`, error?.message || error);
        return res.status(500).json({ error: 'Failed to store Calendly event.' });
    }
}

router.post('/webhook/calendly/:userId/:clientId', handleCalendlyWebhookEvent);
router.post('/calendly/:userId/:clientId', handleCalendlyWebhookEvent);

export default router;
