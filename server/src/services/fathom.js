/**
 * Fathom API client (https://developers.fathom.ai). API keys are per Fathom
 * user and sent as X-Api-Key. Webhooks are signed Standard-Webhooks style:
 * HMAC-SHA256 of `${webhook-id}.${webhook-timestamp}.${rawBody}` with the
 * base64-decoded part of the `whsec_…` secret.
 */
import crypto from 'crypto';

const FATHOM_API_BASE = 'https://api.fathom.ai/external/v1';
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export async function fathomRequest({ apiKey, path, method = 'GET', body }) {
    const res = await fetch(`${FATHOM_API_BASE}${path}`, {
        method,
        headers: {
            'X-Api-Key': apiKey,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = null;
    }
    if (!res.ok) {
        const error = new Error(`Fathom ${method} ${path} failed (${res.status}): ${data?.message || data?.error || text.slice(0, 200)}`);
        error.statusCode = res.status;
        throw error;
    }
    return data;
}

/**
 * Meetings created in [createdAfter, createdBefore) (ISO), with transcript and
 * summary unless `withContent` is false. `stopWhen(meeting)` ends paging early
 * once it returns true for a meeting on the page just read.
 */
export async function listFathomMeetings({ apiKey, createdAfter, createdBefore = null, withContent = true, maxPages = 20, stopWhen = null }) {
    const meetings = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page += 1) {
        const params = new URLSearchParams(withContent ? { include_transcript: 'true', include_summary: 'true' } : {});
        if (createdAfter) params.set('created_after', createdAfter);
        if (createdBefore) params.set('created_before', createdBefore);
        if (cursor) params.set('cursor', cursor);
        const data = await fathomRequest({ apiKey, path: `/meetings?${params}` });
        const items = Array.isArray(data?.items) ? data.items : [];
        meetings.push(...items);
        if (stopWhen && items.some(stopWhen)) break;
        cursor = data?.next_cursor || null;
        if (!cursor) break;
    }
    return meetings;
}

/**
 * A Fathom call link in one comparable form: https, no www, no query or hash,
 * no trailing slash. Returns null for anything that isn't a fathom.video call
 * or share link.
 */
export function normalizeFathomUrl(raw) {
    let url;
    let text = String(raw || '').trim();
    if (text && !/^[a-z]+:\/\//i.test(text)) text = `https://${text}`;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'fathom.video') return null;
    const path = url.pathname.replace(/\/+$/, '');
    if (!/^\/(calls|share)\/[^/]+/.test(path)) return null;
    return `https://fathom.video${path}`;
}

export async function createFathomWebhook({ apiKey, destinationUrl }) {
    return fathomRequest({
        apiKey,
        path: '/webhooks',
        method: 'POST',
        body: {
            destination_url: destinationUrl,
            triggered_for: ['my_recordings'],
            include_transcript: true,
            include_summary: true,
            include_action_items: false,
            include_crm_matches: false
        }
    });
}

export async function deleteFathomWebhook({ apiKey, webhookId }) {
    return fathomRequest({ apiKey, path: `/webhooks/${encodeURIComponent(webhookId)}`, method: 'DELETE' });
}

function secretBytes(secret) {
    const raw = String(secret || '').trim();
    const encoded = raw.startsWith('whsec_') ? raw.slice('whsec_'.length) : raw;
    return Buffer.from(encoded, 'base64');
}

/**
 * @param {{ rawBody: Buffer|string, headers: Record<string, any>, secret: string, nowSeconds?: number }} args
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyFathomSignature({ rawBody, headers, secret, nowSeconds = Math.floor(Date.now() / 1000) }) {
    if (!secret) return { valid: false, reason: 'no_secret' };
    const id = String(headers['webhook-id'] || '');
    const timestamp = String(headers['webhook-timestamp'] || '');
    const signatureHeader = String(headers['webhook-signature'] || '');
    if (!id || !timestamp || !signatureHeader) return { valid: false, reason: 'missing_headers' };
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > SIGNATURE_TOLERANCE_SECONDS) {
        return { valid: false, reason: 'timestamp_out_of_tolerance' };
    }
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
    const expected = crypto
        .createHmac('sha256', secretBytes(secret))
        .update(`${id}.${timestamp}.${body}`)
        .digest();
    const matches = signatureHeader.split(' ').some((part) => {
        const [, signature] = part.split(',');
        if (!signature) return false;
        const provided = Buffer.from(signature, 'base64');
        return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    });
    return matches ? { valid: true } : { valid: false, reason: 'signature_mismatch' };
}
