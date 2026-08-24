import crypto from 'crypto';
import axios from 'axios';
import { pool } from '../lib/db.js';
import { getOrCreateClient } from '../services/db/queries.js';
import { notifyEssenceAiDemoBooked } from './discoveryCallResend.js';
import { resolveCaseStudyIndustry } from './discoveryCallCaseStudy.js';

const CALENDLY_API_BASE = 'https://api.calendly.com';

function normalizeEmail(email) {
    if (!email || typeof email !== 'string') return null;
    const normalized = email.trim().toLowerCase();
    return normalized || null;
}

function extractUuidFromUri(uri) {
    if (!uri || typeof uri !== 'string') return null;
    const parts = uri.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || null;
}

function parseScheduledEventStartTime(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseSignatureHeader(header) {
    if (!header || typeof header !== 'string') {
        return { timestamp: null, signature: null };
    }

    let timestamp = null;
    let signature = null;
    for (const part of header.split(',')) {
        const [key, value] = part.trim().split('=');
        if (key === 't') timestamp = value || null;
        if (key === 'v1') signature = value || null;
    }
    return { timestamp, signature };
}

/**
 * Verify Calendly-Webhook-Signature header (HMAC-SHA256 of `${timestamp}.${rawBody}`).
 */
export function verifyCalendlySignature(rawBody, signatureHeader, secret) {
    if (!secret) {
        return { valid: true, skipped: true };
    }

    const { timestamp, signature } = parseSignatureHeader(signatureHeader);
    if (!timestamp || !signature) {
        return { valid: false, reason: 'missing_signature_parts' };
    }

    const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''));
    const expected = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.`)
        .update(payload)
        .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(signature, 'hex');
    if (expectedBuf.length !== actualBuf.length) {
        return { valid: false, reason: 'length_mismatch' };
    }

    const valid = crypto.timingSafeEqual(expectedBuf, actualBuf);
    return { valid, reason: valid ? null : 'signature_mismatch' };
}

function parseWebhookPayload(body) {
    const eventType = typeof body?.event === 'string' ? body.event : '';
    const payload = (typeof body?.payload === 'object' && body.payload) ? body.payload : body || {};

    const invitee = (typeof payload.invitee === 'object' && payload.invitee) ? payload.invitee : payload;
    const scheduledEventUri = [
        payload.scheduled_event?.uri,
        payload.event,
        invitee.event,
        payload.scheduled_event
    ].find(v => typeof v === 'string' && v.includes('/scheduled_events/')) || null;

    const inviteeUri = [
        invitee.uri,
        payload.uri
    ].find(v => typeof v === 'string' && v.includes('/invitees/')) || null;

    const email = normalizeEmail([
        invitee.email,
        payload.email,
        body?.email
    ].find(v => typeof v === 'string' && v.includes('@')));

    const inviteeName = invitee.name
        || `${invitee.first_name || ''} ${invitee.last_name || ''}`.trim()
        || payload.name
        || null;

    const scheduledEventStartTime = parseScheduledEventStartTime(
        payload.scheduled_event?.start_time
    );

    return {
        eventType,
        payload,
        invitee,
        scheduledEventUri,
        inviteeUri,
        email,
        inviteeName,
        scheduledEventStartTime,
        calendlyEventUuid: extractUuidFromUri(inviteeUri || scheduledEventUri)
    };
}

async function calendlyApiGet(path, pat) {
    if (!pat) return null;
    const url = path.startsWith('http') ? path : `${CALENDLY_API_BASE}${path}`;
    const response = await axios.get(url, {
        headers: {
            Authorization: `Bearer ${pat}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });
    return response.data?.resource || response.data || null;
}

async function fetchCalendlyEventDetails(scheduledEventUri, pat) {
    if (!scheduledEventUri || !pat) {
        return { scheduledEvent: null, invitees: [] };
    }

    const eventUuid = extractUuidFromUri(scheduledEventUri);
    if (!eventUuid) {
        return { scheduledEvent: null, invitees: [] };
    }

    const [scheduledEvent, inviteesResponse] = await Promise.all([
        calendlyApiGet(`/scheduled_events/${eventUuid}`, pat),
        calendlyApiGet(`/scheduled_events/${eventUuid}/invitees`, pat)
    ]);

    const invitees = Array.isArray(inviteesResponse?.collection)
        ? inviteesResponse.collection
        : (Array.isArray(inviteesResponse) ? inviteesResponse : []);

    return { scheduledEvent, invitees };
}

async function findContactByEmail(email, { agencyId = null, clientId = null } = {}) {
    if (!email) return null;

    const params = [email];
    let whereClause = 'LOWER(c.email) = $1';

    if (agencyId) {
        params.push(agencyId);
        whereClause += ` AND c.agency_id = $${params.length}`;
    }
    if (clientId) {
        params.push(clientId);
        whereClause += ` AND c.client_id = $${params.length}`;
    }

    const result = await pool.query(
        `SELECT c.id, c.agency_id, c.client_id, c.full_name, c.email,
                co.domain_normalized AS domain,
                ci.uses_klaviyo
         FROM contacts c
         LEFT JOIN companies co ON co.id = c.company_id
         LEFT JOIN contact_insights ci ON ci.contact_id = c.id
         WHERE ${whereClause}
         ORDER BY c.last_contacted_at DESC NULLS LAST, c.updated_at DESC
         LIMIT 1`,
        params
    );

    return result.rows[0] || null;
}

async function findResearchIndustryForContact(contactId) {
    if (!contactId) return null;
    const result = await pool.query(
        `SELECT research_brief->>'industry' AS industry
         FROM interested_autoresponder_drafts
         WHERE contact_id = $1
           AND research_brief IS NOT NULL
         ORDER BY COALESCE(research_completed_at, updated_at, created_at) DESC
         LIMIT 1`,
        [contactId]
    );
    return resolveCaseStudyIndustry(result.rows[0]?.industry);
}

function buildTimelineFingerprint({ inviteeUri, email, startTime, timelineEventType }) {
    const inviteeUuid = extractUuidFromUri(inviteeUri);
    const fingerprintBase = `calendly|${inviteeUuid || email}|${startTime || ''}|${timelineEventType}`;
    return crypto.createHash('sha256').update(fingerprintBase).digest('hex');
}

function buildTimelineMessage({ inviteeName, eventName, timelineEventType }) {
    if (timelineEventType === 'meeting_canceled') {
        return inviteeName
            ? `${inviteeName} canceled: ${eventName || 'meeting'}`
            : (eventName ? `Meeting canceled: ${eventName}` : 'Meeting canceled');
    }
    return inviteeName
        ? `${inviteeName} booked: ${eventName || 'meeting'}`
        : (eventName || 'Meeting booked');
}

async function insertTimelineEvent({
    agencyId,
    clientId,
    contactId,
    timelineEventType,
    email,
    messageText,
    eventTimestamp,
    fingerprint,
    storedPayload
}) {
    await pool.query(
        `INSERT INTO contact_instantly_events (
            agency_id, client_id, contact_id,
            event_type, lead_email,
            message_text, event_timestamp, fingerprint, source, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'calendly', $9::jsonb)
        ON CONFLICT (source, fingerprint) DO NOTHING`,
        [
            agencyId,
            clientId,
            contactId,
            timelineEventType,
            email,
            messageText,
            eventTimestamp,
            fingerprint,
            JSON.stringify(storedPayload)
        ]
    );
}

async function persistCalendlyEvent({
    eventType,
    calendlyEventUuid,
    webhookDeliveryId,
    scheduledEventUri,
    inviteeUri,
    email,
    inviteeName,
    startTime,
    payload
}) {
    const result = await pool.query(
        `INSERT INTO calendly_events (
            event_type, calendly_event_uuid, webhook_delivery_id,
            calendly_event_uri, invitee_uri, invitee_email, invitee_name,
            start_time, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING id`,
        [
            eventType,
            calendlyEventUuid,
            webhookDeliveryId,
            scheduledEventUri,
            inviteeUri,
            email,
            inviteeName,
            startTime,
            JSON.stringify(payload)
        ]
    );

    if (result.rows.length > 0) {
        return { inserted: true, id: result.rows[0].id };
    }

    // Duplicate — look up existing row for idempotency reporting
    const existing = await pool.query(
        `SELECT id FROM calendly_events
         WHERE ($1::text IS NOT NULL AND webhook_delivery_id = $1)
            OR ($2::text IS NOT NULL AND event_type = $2 AND invitee_uri = $3)
         LIMIT 1`,
        [webhookDeliveryId, eventType, inviteeUri]
    );

    return { inserted: false, id: existing.rows[0]?.id || null, duplicate: true };
}

async function upsertCalendlyBooking({
    scheduledEventUri,
    inviteeUri,
    eventName,
    startTime,
    endTime,
    inviteeName,
    email,
    timezone,
    status,
    location,
    questionsAndAnswers,
    rawScheduledEvent,
    rawInvitee,
    contact
}) {
    const result = await pool.query(
        `INSERT INTO calendly_bookings (
            scheduled_event_uri, invitee_uri, event_name,
            start_time, end_time, invitee_name, invitee_email,
            timezone, status, location, questions_and_answers,
            raw_scheduled_event, raw_invitee,
            contact_id, agency_id, client_id, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, $16, NOW())
        ON CONFLICT (scheduled_event_uri) DO UPDATE SET
            invitee_uri = EXCLUDED.invitee_uri,
            event_name = COALESCE(EXCLUDED.event_name, calendly_bookings.event_name),
            start_time = COALESCE(EXCLUDED.start_time, calendly_bookings.start_time),
            end_time = COALESCE(EXCLUDED.end_time, calendly_bookings.end_time),
            invitee_name = COALESCE(EXCLUDED.invitee_name, calendly_bookings.invitee_name),
            invitee_email = COALESCE(EXCLUDED.invitee_email, calendly_bookings.invitee_email),
            timezone = COALESCE(EXCLUDED.timezone, calendly_bookings.timezone),
            status = EXCLUDED.status,
            location = COALESCE(EXCLUDED.location, calendly_bookings.location),
            questions_and_answers = CASE
                WHEN EXCLUDED.questions_and_answers = '[]'::jsonb THEN calendly_bookings.questions_and_answers
                ELSE EXCLUDED.questions_and_answers
            END,
            raw_scheduled_event = calendly_bookings.raw_scheduled_event || EXCLUDED.raw_scheduled_event,
            raw_invitee = calendly_bookings.raw_invitee || EXCLUDED.raw_invitee,
            contact_id = COALESCE(EXCLUDED.contact_id, calendly_bookings.contact_id),
            agency_id = COALESCE(EXCLUDED.agency_id, calendly_bookings.agency_id),
            client_id = COALESCE(EXCLUDED.client_id, calendly_bookings.client_id),
            updated_at = NOW()
        RETURNING id, status, contact_id`,
        [
            scheduledEventUri,
            inviteeUri,
            eventName,
            startTime,
            endTime,
            inviteeName,
            email,
            timezone,
            status,
            location,
            JSON.stringify(questionsAndAnswers || []),
            JSON.stringify(rawScheduledEvent || {}),
            JSON.stringify(rawInvitee || {}),
            contact?.id || null,
            contact?.agency_id || null,
            contact?.client_id || null
        ]
    );

    return result.rows[0] || null;
}

function resolveEventTimestamp(value) {
    if (!value) return new Date();
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function resolveTimelineEventTimestamp({ eventType, invitee, payload, body, enrichedInvitee = null }) {
    const source = enrichedInvitee || invitee;

    if (eventType === 'invitee.canceled') {
        return resolveEventTimestamp(
            source?.updated_at
            || invitee?.updated_at
            || payload?.updated_at
            || body?.created_at
        );
    }

    return resolveEventTimestamp(
        source?.created_at
        || invitee?.created_at
        || payload?.created_at
        || body?.created_at
    );
}

function extractLocation(scheduledEvent) {
    if (!scheduledEvent?.location) return null;
    if (typeof scheduledEvent.location === 'string') return scheduledEvent.location;
    if (typeof scheduledEvent.location?.join_url === 'string') return scheduledEvent.location.join_url;
    if (typeof scheduledEvent.location?.location === 'string') return scheduledEvent.location.location;
    return JSON.stringify(scheduledEvent.location);
}

/**
 * Process a Calendly webhook: persist event, upsert booking, match contact, add timeline entry.
 */
export async function processCalendlyWebhook({
    body,
    deliveryId = null,
    pat = process.env.CALENDLY_PAT || '',
    scope = {}
}) {
    const startMs = Date.now();
    const parsed = parseWebhookPayload(body);
    const {
        eventType,
        payload,
        invitee,
        scheduledEventUri,
        inviteeUri,
        email,
        inviteeName,
        scheduledEventStartTime,
        calendlyEventUuid
    } = parsed;

    const logBase = {
        event: eventType,
        email: email || null,
        scheduled_event_uri: scheduledEventUri || null
    };

    if (!eventType) {
        return { ...logBase, success: false, skipped: true, reason: 'missing_event_type', duration_ms: Date.now() - startMs };
    }

    const webhookDeliveryId = deliveryId
        || (typeof body?.webhook_delivery_id === 'string' ? body.webhook_delivery_id : null)
        || null;

    const eventRecord = await persistCalendlyEvent({
        eventType,
        calendlyEventUuid,
        webhookDeliveryId,
        scheduledEventUri,
        inviteeUri,
        email,
        inviteeName,
        startTime: scheduledEventStartTime,
        payload: body
    });

    if (eventRecord.duplicate) {
        return {
            ...logBase,
            success: true,
            duplicate: true,
            duration_ms: Date.now() - startMs
        };
    }

    let scheduledEvent = payload.scheduled_event || null;
    let enrichedInvitee = null;
    let questionsAndAnswers = invitee.questions_and_answers || payload.questions_and_answers || [];

    if (eventType === 'invitee.created' && scheduledEventUri && pat) {
        try {
            const details = await fetchCalendlyEventDetails(scheduledEventUri, pat);
            scheduledEvent = details.scheduledEvent || scheduledEvent;

            enrichedInvitee = details.invitees.find(i => normalizeEmail(i.email) === email)
                || details.invitees[0]
                || null;
            if (enrichedInvitee?.questions_and_answers?.length) {
                questionsAndAnswers = enrichedInvitee.questions_and_answers;
            }
        } catch (error) {
            console.warn('[calendly-webhook] failed to fetch event details:', error?.message || error);
        }
    }

    const enrichedStartTime = parseScheduledEventStartTime(scheduledEvent?.start_time);
    if (eventRecord.id && !scheduledEventStartTime && enrichedStartTime) {
        await pool.query(
            `UPDATE calendly_events
             SET start_time = $1::timestamptz
             WHERE id = $2 AND start_time IS NULL`,
            [enrichedStartTime, eventRecord.id]
        );
    }

    const eventName = scheduledEvent?.name || payload.event_type?.name || null;
    const startTime = scheduledEvent?.start_time || invitee.created_at || payload.start_time || null;
    const endTime = scheduledEvent?.end_time || payload.end_time || null;
    const timezone = invitee.timezone || payload.timezone || scheduledEvent?.timezone || null;
    const location = extractLocation(scheduledEvent) || payload.location || null;

    const bookingStatus = eventType === 'invitee.canceled' ? 'canceled' : 'active';
    const timelineEventType = eventType === 'invitee.canceled' ? 'meeting_canceled' : 'lead_meeting_booked';

    const contact = await findContactByEmail(email, scope);
    let timelineAdded = false;

    if (contact) {
        const eventTimestamp = resolveTimelineEventTimestamp({
            eventType,
            invitee,
            payload,
            body,
            enrichedInvitee
        });
        const fingerprint = buildTimelineFingerprint({
            inviteeUri,
            email,
            startTime,
            timelineEventType
        });
        const messageText = buildTimelineMessage({ inviteeName, eventName, timelineEventType });
        const storedPayload = {
            calendly_event: eventType,
            invitee_uri: inviteeUri,
            scheduled_event_uri: scheduledEventUri,
            meeting_name: eventName,
            start_time: startTime,
            end_time: endTime,
            timezone,
            location,
            cancel_url: payload.cancel_url || null,
            reschedule_url: payload.reschedule_url || null,
            questions_and_answers: questionsAndAnswers,
            contact_id: contact.id,
            raw: body
        };

        await insertTimelineEvent({
            agencyId: contact.agency_id,
            clientId: contact.client_id,
            contactId: contact.id,
            timelineEventType,
            email,
            messageText,
            eventTimestamp,
            fingerprint,
            storedPayload
        });
        timelineAdded = true;
    }

    if (scheduledEventUri) {
        await upsertCalendlyBooking({
            scheduledEventUri,
            inviteeUri,
            eventName,
            startTime,
            endTime,
            inviteeName,
            email,
            timezone,
            status: bookingStatus,
            location,
            questionsAndAnswers,
            rawScheduledEvent: scheduledEvent || {},
            rawInvitee: invitee || {},
            contact
        });
    }

    let resendNotify = null;
    if (eventType === 'invitee.created') {
        try {
            const industry = await findResearchIndustryForContact(contact?.id);
            resendNotify = await notifyEssenceAiDemoBooked({
                eventType,
                eventName,
                email,
                inviteeName,
                invitee,
                enrichedInvitee,
                payload,
                scheduledEvent,
                questionsAndAnswers,
                location,
                startTime,
                contact,
                industry
            });
        } catch (error) {
            console.warn('[calendly-webhook] resend discovery notify failed:', error?.message || error);
            resendNotify = { skipped: false, success: false, error: error?.message || String(error) };
        }
    }

    const result = {
        ...logBase,
        success: true,
        contact_id: contact?.id || null,
        timeline_added: timelineAdded,
        booking_status: bookingStatus,
        resend: resendNotify,
        duration_ms: Date.now() - startMs
    };

    console.log(JSON.stringify(result));
    return result;
}

/**
 * Legacy per-client webhook handler — scopes contact lookup to agency + client.
 */
export async function processCalendlyWebhookForClient({ body, agencyId, clientId, deliveryId = null }) {
    const sqlClientId = await getOrCreateClient(agencyId, clientId);

    return processCalendlyWebhook({
        body,
        deliveryId,
        scope: {
            agencyId,
            clientId: sqlClientId
        }
    });
}

export {
    normalizeEmail,
    parseScheduledEventStartTime,
    parseWebhookPayload,
    resolveTimelineEventTimestamp,
    verifyCalendlySignature as verifySignature
};
