/**
 * Rebuild an email thread from contact_instantly_events rows for the review
 * page. Pure: no DB / network.
 *
 * Instantly emits several events per email — a reply arrives as
 * reply_received plus a categorised twin (lead_interested, …) and a
 * "Warm Follow Up" stamp, all carrying the same reply_text — so rows are
 * classified by what their payload carries, deduped by direction + text, and
 * ordered oldest → newest.
 */
import { stripHtmlToText } from '../services/interestedResearch/briefUtils.js';

export const THREAD_MESSAGE_LIMIT = 60;

const OUTBOUND_EVENT_TYPES = new Set(['email_sent', 'interested_reply_sent', 'manual_reply_sent']);
const INBOUND_EVENT_TYPES = new Set(['reply_received', 'auto_reply_received']);

function asText(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

function parsePayload(payload) {
    if (!payload) return {};
    if (typeof payload === 'string') {
        try {
            const parsed = JSON.parse(payload);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }
    return typeof payload === 'object' ? payload : {};
}

/**
 * Drop the quoted history a mail client appends below a reply
 * ("On Wed, Sep 2 … wrote:", "> quoted", Outlook's "From: … Sent: …" block).
 * Falls back to the full text when trimming would leave nothing.
 */
export function stripQuotedHistory(text) {
    const source = asText(text);
    if (!source) return '';
    const markers = [
        /\n\s*On .{3,240}?wrote:\s*(\n|$)/s,
        /\n\s*-{2,}\s*Original Message\s*-{2,}/i,
        /\n\s*From:\s.{1,200}\n\s*(Sent|Date):\s/i,
        /\n\s*>/
    ];
    let cut = source.length;
    for (const marker of markers) {
        const match = source.match(marker);
        if (match && match.index !== undefined && match.index < cut) cut = match.index;
    }
    const trimmed = source.slice(0, cut).trim();
    return trimmed || source;
}

function classify(row, payload) {
    const eventType = asText(row.event_type);
    const inboundBody = asText(payload.reply_text) || asText(payload.reply_html) || asText(payload.reply_text_snippet);
    const outboundBody = asText(payload.email_text) || asText(payload.email_html);
    if (INBOUND_EVENT_TYPES.has(eventType) || (inboundBody && !OUTBOUND_EVENT_TYPES.has(eventType))) return 'inbound';
    if (OUTBOUND_EVENT_TYPES.has(eventType) || outboundBody) return 'outbound';
    return null;
}

function messageKind(eventType, payload, direction) {
    if (direction === 'inbound') return eventType === 'auto_reply_received' ? 'auto_reply' : 'reply';
    if (eventType === 'interested_reply_sent') return 'autoresponder';
    if (eventType === 'manual_reply_sent') return 'manual';
    if (payload.follow_up_send_id) return 'follow_up';
    return 'campaign';
}

function bodyFor(row, payload, direction) {
    if (direction === 'inbound') {
        return asText(payload.reply_text)
            || asText(row.message_text)
            || asText(payload.reply_text_snippet)
            || asText(row.reply_text_snippet)
            || stripHtmlToText(asText(payload.reply_html));
    }
    return asText(payload.email_text)
        || asText(row.message_text)
        || stripHtmlToText(asText(payload.email_html));
}

function subjectFor(payload) {
    return asText(payload.subject)
        || asText(payload.email_subject)
        || asText(payload.reply_subject)
        || asText(payload.thread_subject)
        || null;
}

function dedupeKey(direction, text) {
    return `${direction}:${text.toLowerCase().replace(/\s+/g, ' ').slice(0, 160)}`;
}

/**
 * @param {Array<object>} rows contact_instantly_events rows (any order)
 * @param {{ leadEmail?: string, limit?: number }} [opts]
 * @returns {Array<{ id: number|string, direction: 'inbound'|'outbound', kind: string, from: string|null, subject: string|null, text: string, sentAt: string|null }>}
 */
export function buildThreadMessages(rows, { leadEmail = '', limit = THREAD_MESSAGE_LIMIT } = {}) {
    const byKey = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row) continue;
        const payload = parsePayload(row.payload);
        const direction = classify(row, payload);
        if (!direction) continue;
        const text = stripQuotedHistory(bodyFor(row, payload, direction));
        if (!text) continue;

        const sentAt = row.event_timestamp ? new Date(row.event_timestamp) : null;
        const message = {
            id: row.id ?? `${direction}-${byKey.size}`,
            direction,
            kind: messageKind(asText(row.event_type), payload, direction),
            from: direction === 'inbound'
                ? (asText(row.lead_email) || asText(payload.lead_email) || asText(leadEmail) || null)
                : (asText(row.email_account) || asText(payload.email_account) || null),
            subject: subjectFor(payload),
            text,
            sentAt: sentAt && !Number.isNaN(sentAt.getTime()) ? sentAt.toISOString() : null
        };

        // Keep the earliest event for a given message — the raw reply_received
        // lands before its categorised twins.
        const key = dedupeKey(direction, text);
        const existing = byKey.get(key);
        if (!existing || (message.sentAt && existing.sentAt && message.sentAt < existing.sentAt)) {
            byKey.set(key, message);
        }
    }

    return [...byKey.values()]
        .sort((a, b) => String(a.sentAt || '').localeCompare(String(b.sentAt || '')))
        .slice(-Math.max(1, limit));
}
