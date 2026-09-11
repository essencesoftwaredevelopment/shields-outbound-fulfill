/**
 * leadManualReply.js
 *
 * Free-hand replies to a lead from the lead modal. Sends through Instantly's
 * POST /api/v2/emails/reply anchored on the lead's latest thread message.
 * The composer is a WYSIWYG editor: its HTML is sanitized here (allow-list
 * from followUpSender.sanitizeHtml) and styled for mail clients. Instantly's
 * reply endpoint has no attachments field, so images are hosted in Supabase
 * Storage (public bucket) and embedded inline wherever the user placed them.
 *
 * Thread anchor resolution:
 *   1. contact_instantly_events — the same reply_to_uuid / eaccount / subject
 *      resolution the autoresponder and warm follow-ups use.
 *   2. Live GET /api/v2/emails?lead=…&campaign_id=… when our events carry no
 *      usable anchor (lead never replied, webhooks missed, etc.). Prefers the
 *      lead's inbound message (ue_type 2), then campaign sends (ue_type 1);
 *      API-sent replies (ue_type 3) are avoided — replying to those delivers
 *      back to the sending account.
 *
 * The sent reply is mirrored to contact_instantly_events as
 * event_type='manual_reply_sent', source='manual'. reply_to_uuid is left NULL
 * on that row on purpose: the sent message id must never become a thread
 * anchor for later automated replies (see followUpSender.resolveThreadReplyAnchor).
 */

import crypto from 'crypto';
import { pool } from '../config/db.js';
import { env } from '../config/env.js';
import { getSupabaseAdmin } from '../config/supabase.js';
import {
    fetchInstantlyEmailSubject,
    fetchLatestThreadMetadata,
    resolveInstantlyReplySubject
} from './interestedAutoResponder.js';
import { htmlToPlainText, sanitizeHtml } from './followUpSender.js';

const INSTANTLY_API_BASE_URL = 'https://api.instantly.ai';
const INSTANTLY_REQUEST_TIMEOUT_MS = 30_000;

export const LEAD_REPLY_IMAGE_BUCKET = 'lead-reply-images';
export const LEAD_REPLY_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const LEAD_REPLY_MAX_IMAGES = 10;
export const LEAD_REPLY_MAX_TEXT_CHARS = 20_000;
export const LEAD_REPLY_MAX_HTML_CHARS = 200_000;
export const LEAD_REPLY_IMAGE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp'
]);

const MIME_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp'
};

function asTrimmedText(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
}

function httpError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const IMG_TAG_PATTERN = /<img\b[^>]*>/gi;

function attrValue(tag, name) {
    const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
    return match ? match[1] : null;
}

/**
 * Editor HTML → { html, text, images } ready for Instantly.
 *
 * sanitizeHtml keeps only safe tags and href/src/alt/width/height, so every
 * attribute we style back on is one we put there. Each <img src> must be one
 * of ours — the body is otherwise free-form, so a foreign src would let a
 * caller embed tracking pixels into a client's outbound mail.
 */
export function prepareManualReplyHtml(rawHtml = '') {
    const source = String(rawHtml || '');
    if (source.length > LEAD_REPLY_MAX_HTML_CHARS) {
        throw httpError('Reply is too long.', 400);
    }

    let html = sanitizeHtml(source);

    const images = [];
    html = html.replace(IMG_TAG_PATTERN, (tag) => {
        const src = attrValue(tag, 'src');
        if (!isAllowedReplyImageUrl(src)) {
            throw httpError('Only images uploaded through the lead modal can be attached.', 400);
        }
        const alt = attrValue(tag, 'alt') || 'image';
        // width comes from the composer's drag-resize (digits only, per sanitizeHtml).
        const width = attrValue(tag, 'width');
        images.push({ url: src, name: alt, width: width ? Number(width) : null });
        const widthAttr = width ? ` width="${width}"` : '';
        const widthStyle = width ? `width:${width}px;` : '';
        return `<img src="${src}" alt="${alt}"${widthAttr} style="${widthStyle}max-width:100%;height:auto;vertical-align:middle;border:0;">`;
    });
    if (images.length > LEAD_REPLY_MAX_IMAGES) {
        throw httpError(`At most ${LEAD_REPLY_MAX_IMAGES} images per reply.`, 400);
    }

    html = html
        .replace(/<a href="/gi, '<a style="color:#2563eb;" href="')
        .replace(/<p>/gi, '<p style="margin:0 0 1em 0;">')
        // Mail clients want explicit line breaks; empty editor paragraphs carry a <br> already.
        .replace(/<br>/gi, '<br/>');

    const bodyText = htmlToPlainText(html);
    if (bodyText.length > LEAD_REPLY_MAX_TEXT_CHARS) {
        throw httpError(`Reply must be ${LEAD_REPLY_MAX_TEXT_CHARS} characters or fewer.`, 400);
    }
    if (!bodyText && !images.length) {
        throw httpError('Write a message or attach an image.', 400);
    }

    const text = [bodyText, images.map((image) => image.url).join('\n')].filter(Boolean).join('\n\n');
    return {
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#222;">${html}</div>`,
        text,
        images
    };
}

function buildReplySnippet(text = '') {
    const firstLine = String(text || '')
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean);
    return firstLine || null;
}

// ─── Image hosting (Supabase Storage) ────────────────────────────────────────

export function getLeadReplyImagePublicPrefix() {
    const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
    if (!base) return null;
    return `${base}/storage/v1/object/public/${LEAD_REPLY_IMAGE_BUCKET}/`;
}

/**
 * Only images we host may be embedded — the reply body is otherwise free-form
 * text, so an arbitrary <img src> would let a caller embed tracking pixels or
 * foreign content into a client's outbound mail.
 */
export function isAllowedReplyImageUrl(url, prefix = getLeadReplyImagePublicPrefix()) {
    const value = asTrimmedText(url);
    if (!value || !prefix) return false;
    if (!value.startsWith(prefix)) return false;
    const rest = value.slice(prefix.length);
    return /^[A-Za-z0-9_\-./]+$/.test(rest) && !rest.includes('..');
}

let bucketReadyPromise = null;

/** Idempotent: create the public bucket on first use (migration 0059 also creates it). */
export function ensureLeadReplyImageBucket() {
    if (bucketReadyPromise) return bucketReadyPromise;
    bucketReadyPromise = (async () => {
        const storage = getSupabaseAdmin().storage;
        const { data: existing } = await storage.getBucket(LEAD_REPLY_IMAGE_BUCKET);
        if (existing) return;
        const { error } = await storage.createBucket(LEAD_REPLY_IMAGE_BUCKET, {
            public: true,
            fileSizeLimit: LEAD_REPLY_IMAGE_MAX_BYTES,
            allowedMimeTypes: [...LEAD_REPLY_IMAGE_MIME_TYPES]
        });
        if (error && !/already exists|duplicate/i.test(error.message || '')) {
            throw error;
        }
    })().catch((error) => {
        bucketReadyPromise = null;
        throw error;
    });
    return bucketReadyPromise;
}

/**
 * Store one image for a lead reply. Path is unguessable (uuid) because the
 * bucket is public — that is what lets mail clients render the embedded image.
 */
export async function uploadLeadReplyImage({ agencyId, contactId, file }) {
    const contentType = String(file?.mimetype || '').toLowerCase();
    if (!LEAD_REPLY_IMAGE_MIME_TYPES.has(contentType)) {
        throw httpError('Only PNG, JPEG, GIF or WebP images can be attached.', 400);
    }
    if (!file?.buffer?.length) {
        throw httpError('Image file is empty.', 400);
    }
    if (file.buffer.length > LEAD_REPLY_IMAGE_MAX_BYTES) {
        throw httpError('Image must be 10MB or smaller.', 400);
    }

    await ensureLeadReplyImageBucket();

    const extension = MIME_EXTENSIONS[contentType] || 'bin';
    const objectPath = `${agencyId}/${contactId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;
    const storage = getSupabaseAdmin().storage.from(LEAD_REPLY_IMAGE_BUCKET);
    const { error } = await storage.upload(objectPath, file.buffer, {
        contentType,
        cacheControl: '31536000',
        upsert: false
    });
    if (error) {
        throw new Error(`Image upload failed: ${error.message || error}`);
    }

    const { data } = storage.getPublicUrl(objectPath);
    return {
        url: data.publicUrl,
        path: objectPath,
        name: asTrimmedText(file.originalname)?.slice(0, 200) || `image.${extension}`,
        size: file.buffer.length,
        contentType
    };
}

// ─── Instantly ───────────────────────────────────────────────────────────────

async function instantlyFetch(apiKey, path, init = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INSTANTLY_REQUEST_TIMEOUT_MS);
    try {
        return await fetch(`${INSTANTLY_API_BASE_URL}${path}`, {
            ...init,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
                ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                ...(init.headers || {})
            },
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeoutId);
    }
}

function extractEmailItems(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.emails)) return payload.emails;
    return [];
}

function emailTimestampMs(email) {
    return new Date(email?.timestamp_email || email?.timestamp_created || email?.created_at || 0).getTime() || 0;
}

/**
 * Pick the message to reply to from a Unibox listing. ue_type: 1 campaign
 * send, 2 received, 3 API/manual send, 4 scheduled. Inbound first (that is
 * the lead's own message), then campaign sends; never an API-sent reply.
 */
export function pickLatestThreadEmail(emails = []) {
    const usable = (emails || []).filter((email) => email && (email.id || email.uuid) && asTrimmedText(email.eaccount));
    if (!usable.length) return null;
    const byType = (type) => usable
        .filter((email) => Number(email.ue_type) === type)
        .sort((a, b) => emailTimestampMs(b) - emailTimestampMs(a));
    return byType(2)[0] || byType(1)[0] || null;
}

async function lookupThreadFromInstantly(apiKey, { leadEmail, instantlyCampaignId }) {
    const params = new URLSearchParams({ lead: leadEmail, limit: '50', sort_order: 'desc' });
    if (instantlyCampaignId) params.set('campaign_id', instantlyCampaignId);
    const response = await instantlyFetch(apiKey, `/api/v2/emails?${params.toString()}`);
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw httpError(`Instantly email lookup failed (${response.status}): ${text.slice(0, 200) || response.statusText}`, 502);
    }
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    const picked = pickLatestThreadEmail(extractEmailItems(payload));
    if (!picked) return null;
    return {
        reply_to_uuid: String(picked.id || picked.uuid),
        eaccount: asTrimmedText(picked.eaccount),
        thread_subject: asTrimmedText(picked.subject || picked.email_subject),
        anchor_source: 'instantly'
    };
}

/**
 * Where a manual reply will land: { reply_to_uuid, eaccount, thread_subject,
 * anchor_source: 'events' | 'instantly' } or null when no thread exists yet.
 */
export async function resolveLeadReplyThread({ contactId, campaignId, instantlyCampaignId, leadEmail, apiKey }) {
    const fromEvents = await fetchLatestThreadMetadata(pool, contactId, campaignId);
    let thread = null;
    if (asTrimmedText(fromEvents.reply_to_uuid) && asTrimmedText(fromEvents.eaccount)) {
        thread = {
            reply_to_uuid: asTrimmedText(fromEvents.reply_to_uuid),
            eaccount: asTrimmedText(fromEvents.eaccount),
            thread_subject: asTrimmedText(fromEvents.thread_subject),
            anchor_source: 'events'
        };
    } else if (apiKey && leadEmail) {
        thread = await lookupThreadFromInstantly(apiKey, { leadEmail, instantlyCampaignId });
        if (thread && !thread.thread_subject) {
            thread.thread_subject = asTrimmedText(fromEvents.thread_subject);
        }
    }
    if (!thread) return null;
    if (!thread.thread_subject && apiKey) {
        thread.thread_subject = await fetchInstantlyEmailSubject(apiKey, thread.reply_to_uuid);
    }
    return thread;
}

/** POST /emails/reply. Retries 429/5xx only — never a timeout, to avoid double-sending. */
async function postInstantlyReply(apiKey, payload) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await instantlyFetch(apiKey, '/api/v2/emails/reply', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        if (response.ok) {
            return response.status === 204 ? null : response.json().catch(() => null);
        }
        const text = await response.text().catch(() => '');
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
            continue;
        }
        throw httpError(
            `Instantly reply failed (${response.status}): ${text.slice(0, 300) || response.statusText}`,
            response.status === 429 ? 429 : 502
        );
    }
    return null;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

async function persistManualReplyEvent(db, {
    agencyId,
    clientId,
    contactId,
    campaignId,
    instantlyCampaignId,
    instantlyLeadId,
    leadEmail,
    eaccount,
    threadSubject,
    sentReplyId,
    parentReplyToUuid,
    anchorSource,
    text,
    html,
    images,
    sentBy
}) {
    const eventTimestamp = new Date().toISOString();
    const fingerprint = crypto
        .createHash('sha256')
        .update(['manual_reply_sent', String(contactId), String(campaignId), sentReplyId || '', eventTimestamp].join('|'))
        .digest('hex');
    const payload = {
        event_type: 'manual_reply_sent',
        source: 'manual',
        subject: threadSubject || null,
        email_subject: threadSubject || null,
        email_text: text || null,
        email_html: html || null,
        email_id: sentReplyId || null,
        parent_reply_to_uuid: parentReplyToUuid || null,
        thread_anchor_source: anchorSource || null,
        images: images.map((image) => ({ url: image.url, name: image.name })),
        sent_by: sentBy || null
    };

    const result = await db.query(
        `INSERT INTO contact_instantly_events (
            agency_id, client_id, contact_id, campaign_id, instantly_campaign_id, instantly_lead_id,
            event_type, lead_email, email_account, message_text, reply_text_snippet,
            event_timestamp, fingerprint, source, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'manual', $14::jsonb)
        ON CONFLICT (source, fingerprint) DO NOTHING
        RETURNING id, event_type, campaign_id, instantly_campaign_id, lead_email, email_account,
                  message_text, reply_text_snippet, event_timestamp, source, payload, created_at`,
        [
            agencyId,
            clientId,
            contactId,
            campaignId,
            instantlyCampaignId || null,
            instantlyLeadId || null,
            'manual_reply_sent',
            leadEmail || null,
            eaccount || null,
            text || null,
            buildReplySnippet(text) || (images.length ? `${images.length} image${images.length === 1 ? '' : 's'}` : null),
            eventTimestamp,
            fingerprint,
            JSON.stringify(payload)
        ]
    );
    return result.rows[0] || null;
}

// ─── Membership ──────────────────────────────────────────────────────────────

/**
 * The lead's campaign row for this client. With one campaign it is implied;
 * with several the caller must name one (Instantly campaign UUID).
 */
export async function resolveLeadCampaignMembership({ agencyId, clientId, contactId, instantlyCampaignId = null }) {
    const result = await pool.query(
        `SELECT
            c.id AS contact_id,
            c.email AS lead_email,
            ic.id AS campaign_id,
            ic.name AS campaign_name,
            ic.instantly_campaign_id,
            cic.instantly_lead_id,
            cic.added_at
         FROM contacts c
         JOIN contact_instantly_campaigns cic ON cic.contact_id = c.id
         JOIN instantly_campaigns ic
           ON ic.id = cic.campaign_id
          AND ic.client_id = c.client_id
          AND ic.agency_id = c.agency_id
         WHERE c.id = $1
           AND c.agency_id = $2
           AND c.client_id = $3
           AND ($4::text IS NULL OR ic.instantly_campaign_id = $4::text)
         ORDER BY cic.added_at DESC NULLS LAST, ic.id DESC`,
        [contactId, agencyId, clientId, asTrimmedText(instantlyCampaignId)]
    );
    if (!result.rows.length) {
        throw httpError(
            instantlyCampaignId
                ? 'Lead is not a member of that Instantly campaign for this client.'
                : 'Lead is not in any Instantly campaign for this client.',
            404
        );
    }
    if (!instantlyCampaignId && result.rows.length > 1) {
        throw httpError('Lead is in several campaigns — pass campaignId.', 400);
    }
    const membership = result.rows[0];
    const leadEmail = String(membership.lead_email || '').trim().toLowerCase();
    if (!leadEmail) {
        throw httpError('Lead has no email address.', 400);
    }
    return { ...membership, lead_email: leadEmail };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function sendLeadManualReply({
    agencyId,
    clientRow,
    contactId,
    instantlyCampaignId = null,
    html: rawHtml,
    sentBy = null
}) {
    const { html, text, images } = prepareManualReplyHtml(rawHtml);

    const apiKey = asTrimmedText(clientRow?.instantly_key);
    if (!apiKey) {
        throw httpError('Client is missing Instantly API key.', 400);
    }

    const membership = await resolveLeadCampaignMembership({
        agencyId,
        clientId: clientRow.id,
        contactId,
        instantlyCampaignId
    });

    const thread = await resolveLeadReplyThread({
        contactId,
        campaignId: membership.campaign_id,
        instantlyCampaignId: membership.instantly_campaign_id,
        leadEmail: membership.lead_email,
        apiKey
    });
    if (!thread) {
        throw httpError('No Instantly thread found for this lead yet — nothing to reply to.', 409);
    }

    const subject = resolveInstantlyReplySubject(thread.thread_subject);

    const replyResult = await postInstantlyReply(apiKey, {
        reply_to_uuid: thread.reply_to_uuid,
        eaccount: thread.eaccount,
        subject,
        body: { html, text }
    });

    const event = await persistManualReplyEvent(pool, {
        agencyId,
        clientId: clientRow.id,
        contactId,
        campaignId: membership.campaign_id,
        instantlyCampaignId: membership.instantly_campaign_id,
        instantlyLeadId: membership.instantly_lead_id,
        leadEmail: membership.lead_email,
        eaccount: thread.eaccount,
        threadSubject: subject,
        sentReplyId: replyResult?.id || replyResult?.email_id || null,
        parentReplyToUuid: thread.reply_to_uuid,
        anchorSource: thread.anchor_source,
        text,
        html,
        images,
        sentBy
    });

    return {
        sent: true,
        event,
        thread: {
            reply_to_uuid: thread.reply_to_uuid,
            eaccount: thread.eaccount,
            subject,
            anchor_source: thread.anchor_source,
            campaign_id: membership.instantly_campaign_id,
            campaign_name: membership.campaign_name
        }
    };
}
