import crypto from 'crypto';
import { pool } from '../lib/db.js';
import { resolveClientRow } from './db/queries.js';
import { normalizeDomain } from '../utils/domain.js';
import { normalizeEmailForMatch } from '../utils/instantlyImportMerge.js';

const SOURCE = 'prospect_activity';

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
    return null;
}

export function titleToEventType(title) {
    const raw = String(title || '').trim().toLowerCase();
    if (!raw) return null;
    const slug = raw
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
    return slug || null;
}

export function parseProspectActivityPayload(body = {}) {
    const title = firstNonEmptyString(
        body.title,
        body.activity_title,
        body.activityTitle,
        body.event_type,
        body.eventType,
        body.name
    );
    const description = firstNonEmptyString(
        body.description,
        body.activity_description,
        body.activityDescription,
        body.message,
        body.message_text,
        body.messageText,
        body.details
    );
    const email = normalizeEmailForMatch(
        firstNonEmptyString(
            body.email,
            body.lead_email,
            body.leadEmail,
            body.recipient,
            body.to
        ) || ''
    );
    const domain = normalizeDomain(
        firstNonEmptyString(body.domain, body.Domain, body.company_domain, body.companyDomain) || ''
    );
    const contactIdRaw = firstNonEmptyString(body.contact_id, body.contactId, body.lead_id, body.leadId);
    const contactId = contactIdRaw && /^\d+$/.test(contactIdRaw) ? Number(contactIdRaw) : null;
    const timestampRaw = firstNonEmptyString(
        body.timestamp,
        body.event_timestamp,
        body.eventTimestamp,
        body.occurred_at,
        body.occurredAt
    );
    const idempotencyKey = firstNonEmptyString(
        body.idempotency_key,
        body.idempotencyKey,
        body.fingerprint,
        body.id
    );
    const metadata = (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata))
        ? body.metadata
        : null;

    return {
        title,
        description,
        email: email || null,
        domain: domain || null,
        contactId: Number.isInteger(contactId) && contactId > 0 ? contactId : null,
        timestampRaw,
        idempotencyKey,
        metadata
    };
}

function resolveEventTimestamp(timestampRaw) {
    if (!timestampRaw) return new Date();
    const parsed = new Date(timestampRaw);
    if (Number.isNaN(parsed.getTime())) {
        const err = new Error('Invalid timestamp. Use an ISO-8601 date string.');
        err.statusCode = 400;
        throw err;
    }
    return parsed;
}

function buildFingerprint({
    agencyId,
    clientId,
    contactId,
    eventType,
    email,
    eventTimestamp,
    idempotencyKey
}) {
    const base = idempotencyKey
        ? `${SOURCE}|idempotency|${agencyId}|${clientId}|${idempotencyKey}`
        : [
            SOURCE,
            agencyId,
            clientId,
            contactId || '',
            eventType,
            email || '',
            eventTimestamp.toISOString()
        ].join('|');
    return crypto.createHash('sha256').update(base).digest('hex');
}

async function findContactById(agencyId, clientId, contactId) {
    const result = await pool.query(
        `SELECT c.id, c.email, c.full_name, co.domain_normalized AS domain
         FROM contacts c
         LEFT JOIN companies co ON co.id = c.company_id
         WHERE c.id = $1
           AND c.agency_id = $2
           AND c.client_id = $3
         LIMIT 1`,
        [contactId, agencyId, clientId]
    );
    return result.rows[0] || null;
}

async function findContactByEmail(agencyId, clientId, email) {
    const result = await pool.query(
        `SELECT c.id, c.email, c.full_name, co.domain_normalized AS domain
         FROM contacts c
         LEFT JOIN companies co ON co.id = c.company_id
         WHERE c.agency_id = $1
           AND c.client_id = $2
           AND LOWER(c.email) = $3
         ORDER BY c.last_contacted_at DESC NULLS LAST, c.updated_at DESC, c.id DESC
         LIMIT 1`,
        [agencyId, clientId, email]
    );
    return result.rows[0] || null;
}

async function findContactByDomain(agencyId, clientId, domain) {
    const result = await pool.query(
        `SELECT c.id, c.email, c.full_name, co.domain_normalized AS domain
         FROM contacts c
         JOIN companies co ON co.id = c.company_id
         WHERE c.agency_id = $1
           AND c.client_id = $2
           AND co.domain_normalized = $3
         ORDER BY c.last_contacted_at DESC NULLS LAST, c.updated_at DESC, c.id DESC
         LIMIT 1`,
        [agencyId, clientId, domain]
    );
    return result.rows[0] || null;
}

async function resolveContact({ agencyId, clientId, contactId, email, domain }) {
    if (contactId) {
        const contact = await findContactById(agencyId, clientId, contactId);
        if (!contact) {
            const err = new Error('No contact found for contact_id in this client.');
            err.statusCode = 404;
            throw err;
        }
        return { contact, matchedBy: 'contact_id' };
    }

    if (email) {
        const contact = await findContactByEmail(agencyId, clientId, email);
        if (!contact) {
            const err = new Error('No contact found for email in this client.');
            err.statusCode = 404;
            throw err;
        }
        return { contact, matchedBy: 'email' };
    }

    if (domain) {
        const contact = await findContactByDomain(agencyId, clientId, domain);
        if (!contact) {
            const err = new Error('No contact found for domain in this client.');
            err.statusCode = 404;
            throw err;
        }
        return { contact, matchedBy: 'domain' };
    }

    const err = new Error('Provide email, domain, or contact_id to identify the prospect.');
    err.statusCode = 400;
    throw err;
}

/**
 * Record an arbitrary prospect activity on the lead timeline.
 * Does not create contacts — identity must match an existing lead.
 */
export async function processProspectActivityWebhook({
    agencyId,
    clientSlug,
    body,
    logger = () => {}
}) {
    const clientRow = await resolveClientRow(agencyId, clientSlug);
    if (!clientRow) {
        const err = new Error('Client not found.');
        err.statusCode = 404;
        throw err;
    }

    const parsed = parseProspectActivityPayload(body);
    if (!parsed.title) {
        const err = new Error('title is required (activity title / event type).');
        err.statusCode = 400;
        throw err;
    }

    const eventType = titleToEventType(parsed.title);
    if (!eventType) {
        const err = new Error('title could not be converted to an event type.');
        err.statusCode = 400;
        throw err;
    }

    const eventTimestamp = resolveEventTimestamp(parsed.timestampRaw);
    const { contact, matchedBy } = await resolveContact({
        agencyId,
        clientId: clientRow.id,
        contactId: parsed.contactId,
        email: parsed.email,
        domain: parsed.domain
    });

    const leadEmail = normalizeEmailForMatch(contact.email || parsed.email || '') || null;
    const messageText = parsed.description || parsed.title;
    const fingerprint = buildFingerprint({
        agencyId,
        clientId: clientRow.id,
        contactId: contact.id,
        eventType,
        email: leadEmail,
        eventTimestamp,
        idempotencyKey: parsed.idempotencyKey
    });

    const storedPayload = {
        title: parsed.title,
        description: parsed.description,
        matched_by: matchedBy,
        email: parsed.email,
        domain: parsed.domain,
        contact_id: parsed.contactId,
        idempotency_key: parsed.idempotencyKey,
        metadata: parsed.metadata,
        raw: body
    };

    const insertResult = await pool.query(
        `INSERT INTO contact_instantly_events (
            agency_id, client_id, contact_id,
            event_type, lead_email,
            message_text, event_timestamp, fingerprint, source, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        ON CONFLICT (source, fingerprint) DO NOTHING
        RETURNING id, event_type, lead_email, message_text, event_timestamp, source, created_at`,
        [
            agencyId,
            clientRow.id,
            contact.id,
            eventType,
            leadEmail,
            messageText,
            eventTimestamp.toISOString(),
            fingerprint,
            SOURCE,
            JSON.stringify(storedPayload)
        ]
    );

    const eventRow = insertResult.rows[0] || null;
    const duplicate = !eventRow;

    logger(
        duplicate
            ? `duplicate activity ignored for contact ${contact.id} (${eventType})`
            : `recorded activity ${eventType} for contact ${contact.id}`
    );

    return {
        ok: true,
        matched: true,
        matched_by: matchedBy,
        duplicate,
        contact_id: contact.id,
        lead_email: leadEmail,
        domain: contact.domain || parsed.domain || null,
        event_type: eventType,
        title: parsed.title,
        description: parsed.description,
        event: eventRow,
        event_id: eventRow?.id || null
    };
}
