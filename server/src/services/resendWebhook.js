/**
 * Resend email webhooks → lead activity timeline.
 *
 * Matches recipients only on the essence-retention client in the Essence
 * Retention agency, then inserts contact_instantly_events with source=resend.
 */

import crypto from 'crypto';
import { pool } from '../lib/db.js';
import { normalizeEmailForMatch } from '../utils/instantlyImportMerge.js';
import {
    ESSENCE_RETENTION_AGENCY_ID,
    ESSENCE_RETENTION_CLIENT_SLUG
} from './resendScope.js';

export const RESEND_EVENT_SOURCE = 'resend';
export const SVIX_TIMESTAMP_TOLERANCE_SEC = 300;

const EVENT_TYPE_MAP = {
    'email.sent': 'email_sent',
    'email.opened': 'email_opened',
    'email.clicked': 'email_link_clicked',
    'email.bounced': 'email_bounced',
    'email.failed': 'email_failed',
    'email.complained': 'email_complained',
    'email.suppressed': 'email_bounced'
};

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

function asStringArray(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => (typeof item === 'string' ? item : item?.email))
            .filter((item) => typeof item === 'string' && item.trim());
    }
    if (typeof value === 'string' && value.trim()) return [value];
    return [];
}

function headerValue(headers = {}, name) {
    const needle = String(name).toLowerCase();
    const match = Object.entries(headers).find(([key]) => String(key).toLowerCase() === needle);
    const value = match?.[1];
    if (Array.isArray(value)) return firstNonEmptyString(...value);
    return typeof value === 'string' ? value : null;
}

function rawBodyToString(rawBody) {
    if (Buffer.isBuffer(rawBody)) return rawBody.toString('utf8');
    if (typeof rawBody === 'string') return rawBody;
    return '';
}

function timingSafeEqualString(left, right) {
    const leftBuf = Buffer.from(String(left || ''));
    const rightBuf = Buffer.from(String(right || ''));
    if (leftBuf.length !== rightBuf.length) return false;
    return crypto.timingSafeEqual(leftBuf, rightBuf);
}

export function mapResendEventType(type) {
    return EVENT_TYPE_MAP[String(type || '').trim()] || null;
}

export function verifyResendSignature(rawBody, headers = {}, secret = '', { now = Date.now() } = {}) {
    if (!secret) {
        return { valid: true, skipped: true };
    }

    const svixId = headerValue(headers, 'svix-id');
    const svixTimestamp = headerValue(headers, 'svix-timestamp');
    const svixSignature = headerValue(headers, 'svix-signature');

    if (!svixId || !svixTimestamp || !svixSignature) {
        return { valid: false, reason: 'missing_svix_headers' };
    }

    const timestamp = Number(svixTimestamp);
    if (!Number.isFinite(timestamp)) {
        return { valid: false, reason: 'invalid_timestamp' };
    }
    if (Math.abs(Math.floor(now / 1000) - timestamp) > SVIX_TIMESTAMP_TOLERANCE_SEC) {
        return { valid: false, reason: 'timestamp_out_of_tolerance' };
    }

    const payload = rawBodyToString(rawBody);
    const signedContent = `${svixId}.${svixTimestamp}.${payload}`;
    const secretBytes = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
    const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

    const candidates = String(svixSignature)
        .split(/\s+/)
        .map((part) => {
            const comma = part.indexOf(',');
            if (comma === -1) return null;
            const version = part.slice(0, comma);
            const signature = part.slice(comma + 1);
            return version === 'v1' && signature ? signature : null;
        })
        .filter(Boolean);

    if (!candidates.length) {
        return { valid: false, reason: 'missing_v1_signature' };
    }

    const matched = candidates.some((candidate) => timingSafeEqualString(candidate, expected));
    return matched ? { valid: true } : { valid: false, reason: 'signature_mismatch' };
}

export function parseResendWebhookEvent(body = {}) {
    const type = firstNonEmptyString(body.type, body.event);
    const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data))
        ? body.data
        : {};
    const emails = asStringArray(data.to)
        .map((email) => normalizeEmailForMatch(email))
        .filter(Boolean);
    const uniqueEmails = [...new Set(emails)];
    const subject = firstNonEmptyString(data.subject);
    const clickUrl = firstNonEmptyString(
        data.click?.link,
        data.click?.url,
        data.link
    );
    const createdAt = firstNonEmptyString(data.created_at, body.created_at);
    const eventTimestamp = createdAt ? new Date(createdAt) : new Date();
    const safeTimestamp = Number.isNaN(eventTimestamp.getTime()) ? new Date() : eventTimestamp;

    return {
        type,
        timelineEventType: mapResendEventType(type),
        emails: uniqueEmails,
        subject,
        clickUrl,
        from: firstNonEmptyString(data.from),
        emailId: firstNonEmptyString(data.email_id, data.emailId),
        templateId: firstNonEmptyString(data.template_id, data.templateId, data.template?.id),
        tags: (data.tags && typeof data.tags === 'object' && !Array.isArray(data.tags)) ? data.tags : null,
        createdAt: safeTimestamp.toISOString(),
        eventTimestamp: safeTimestamp,
        data
    };
}

export function buildResendTimelineMessage({ timelineEventType, subject, clickUrl }) {
    if (timelineEventType === 'email_link_clicked' && clickUrl) {
        return subject ? `${subject}\n${clickUrl}` : clickUrl;
    }
    if (subject) return subject;
    if (timelineEventType === 'email_complained') return 'Marked as spam';
    if (timelineEventType === 'email_failed') return 'Email failed';
    return 'Resend email';
}

export function buildResendFingerprint({ svixId, emailId, timelineEventType, contactId, email }) {
    const base = svixId
        ? `${RESEND_EVENT_SOURCE}|svix|${svixId}|${contactId}`
        : `${RESEND_EVENT_SOURCE}|${emailId || ''}|${timelineEventType}|${contactId}|${email || ''}`;
    return crypto.createHash('sha256').update(base).digest('hex');
}

async function findContactsByEmails(emails) {
    if (!emails.length) return [];
    const result = await pool.query(
        `SELECT c.id, c.agency_id, c.client_id, c.full_name, c.email
         FROM contacts c
         JOIN clients cl ON cl.id = c.client_id AND cl.agency_id = c.agency_id
         WHERE LOWER(c.email) = ANY($1::text[])
           AND c.agency_id = $2
           AND cl.slug = $3
         ORDER BY c.last_contacted_at DESC NULLS LAST, c.updated_at DESC, c.id DESC`,
        [emails, ESSENCE_RETENTION_AGENCY_ID, ESSENCE_RETENTION_CLIENT_SLUG]
    );
    return result.rows;
}

async function insertTimelineEvent({
    agencyId,
    clientId,
    contactId,
    timelineEventType,
    email,
    emailAccount,
    messageText,
    eventTimestamp,
    fingerprint,
    storedPayload
}) {
    const result = await pool.query(
        `INSERT INTO contact_instantly_events (
            agency_id, client_id, contact_id,
            event_type, lead_email, email_account,
            message_text, event_timestamp, fingerprint, source, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        ON CONFLICT (source, fingerprint) DO NOTHING
        RETURNING id, event_type, lead_email, message_text, event_timestamp, source, created_at`,
        [
            agencyId,
            clientId,
            contactId,
            timelineEventType,
            email,
            emailAccount,
            messageText,
            eventTimestamp.toISOString(),
            fingerprint,
            RESEND_EVENT_SOURCE,
            JSON.stringify(storedPayload)
        ]
    );
    return result.rows[0] || null;
}

/**
 * Process a verified Resend webhook payload into lead timeline rows.
 */
export async function processResendWebhook({
    body,
    svixId = null,
    logger = () => {}
}) {
    const startMs = Date.now();
    const parsed = parseResendWebhookEvent(body);

    if (!parsed.timelineEventType) {
        return {
            ok: true,
            skipped: true,
            reason: parsed.type ? 'unhandled_event_type' : 'missing_event_type',
            type: parsed.type || null,
            duration_ms: Date.now() - startMs
        };
    }

    if (!parsed.emails.length) {
        return {
            ok: true,
            skipped: true,
            reason: 'missing_recipient',
            type: parsed.type,
            duration_ms: Date.now() - startMs
        };
    }

    const contacts = await findContactsByEmails(parsed.emails);
    if (!contacts.length) {
        logger(`no contact match for ${parsed.emails.join(', ')} (${parsed.type})`);
        return {
            ok: true,
            matched: false,
            reason: 'no_contact',
            type: parsed.type,
            emails: parsed.emails,
            duration_ms: Date.now() - startMs
        };
    }

    const messageText = buildResendTimelineMessage({
        timelineEventType: parsed.timelineEventType,
        subject: parsed.subject,
        clickUrl: parsed.clickUrl
    });

    const inserted = [];
    let duplicates = 0;

    for (const contact of contacts) {
        const leadEmail = normalizeEmailForMatch(contact.email) || parsed.emails[0];
        const fingerprint = buildResendFingerprint({
            svixId,
            emailId: parsed.emailId,
            timelineEventType: parsed.timelineEventType,
            contactId: contact.id,
            email: leadEmail
        });
        const storedPayload = {
            resend_event: parsed.type,
            email_id: parsed.emailId,
            template_id: parsed.templateId,
            subject: parsed.subject,
            from: parsed.from,
            tags: parsed.tags,
            click_url: parsed.clickUrl,
            contact_id: contact.id,
            raw: body
        };

        const eventRow = await insertTimelineEvent({
            agencyId: contact.agency_id,
            clientId: contact.client_id,
            contactId: contact.id,
            timelineEventType: parsed.timelineEventType,
            email: leadEmail,
            emailAccount: parsed.from,
            messageText,
            eventTimestamp: parsed.eventTimestamp,
            fingerprint,
            storedPayload
        });

        if (eventRow) {
            inserted.push({
                event_id: eventRow.id,
                contact_id: contact.id,
                client_id: contact.client_id
            });
        } else {
            duplicates += 1;
        }
    }

    logger(
        inserted.length
            ? `recorded ${parsed.timelineEventType} for ${inserted.length} contact(s)`
            : `duplicate ${parsed.timelineEventType} ignored`
    );

    return {
        ok: true,
        matched: true,
        type: parsed.type,
        event_type: parsed.timelineEventType,
        emails: parsed.emails,
        inserted_count: inserted.length,
        duplicate_count: duplicates,
        events: inserted,
        duration_ms: Date.now() - startMs
    };
}
