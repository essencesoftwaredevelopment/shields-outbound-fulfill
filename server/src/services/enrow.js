/**
 * Enrow API client (https://api.enrow.io) — optional secondary email provider
 * behind TryKitt. Every endpoint is async: POST returns an id, the result is
 * fetched with GET (we poll; no webhook endpoint is exposed).
 *
 * Only the bulk endpoints are used: one request per enrichment batch keeps well
 * under the 10 req/s POST limit, and bulk costs the same per result as single.
 * Finder misses are free (credits are refunded after the batch completes).
 */

const ENROW_BASE_URL = 'https://api.enrow.io';
const MAX_ATTEMPTS = 4;
const INITIAL_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT_MS = 30000;
/** Enrow's documented per-request bulk ceiling. */
export const ENROW_BULK_MAX = 5000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {number} status
 * @param {string} message
 */
function enrowError(status, message) {
    const err = new Error(`Enrow ${status}: ${message}`);
    err.status = status;
    // 402 = out of credits, 401 = bad key: retrying never helps, and the caller
    // skips the fallback rather than failing the enrichment batch.
    if (status === 402) err.code = 'ENROW_CREDIT_EXHAUSTED';
    // The key is fine but the plan lacks phone search — must not read as a bad key.
    else if (status === 401 && /phone/i.test(message)) err.code = 'ENROW_PHONE_NOT_ALLOWED';
    else if (status === 401) err.code = 'ENROW_UNAUTHORIZED';
    return err;
}

/**
 * @param {'GET' | 'POST'} method
 * @param {string} path
 * @param {string} apiKey
 * @param {unknown} [body]
 */
export async function enrowRequest(method, path, apiKey, body) {
    if (!apiKey) throw enrowError(401, 'missing API key');
    let backoff = INITIAL_BACKOFF_MS;
    for (let attempt = 1; ; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(`${ENROW_BASE_URL}${path}`, {
                method,
                headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            });
        } catch (err) {
            if (attempt >= MAX_ATTEMPTS) {
                throw new Error(`Enrow request failed: ${err?.name === 'AbortError' ? 'timeout' : err?.message || err}`);
            }
            await wait(backoff);
            backoff *= 2;
            continue;
        } finally {
            clearTimeout(timer);
        }

        const text = await res.text();
        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = null;
        }
        if (res.ok) return { status: res.status, body: parsed };

        // Most errors carry `message`; single-endpoint 402s carry `reason`.
        const message = parsed?.message ?? parsed?.reason ?? res.statusText ?? 'unknown error';
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
            await wait(backoff);
            backoff *= 2;
            continue;
        }
        throw enrowError(res.status, message);
    }
}

/**
 * @param {string} apiKey
 * @param {Array<{ contactId: number | string, fullName: string, domain: string }>} searches
 * @param {Record<string, unknown>} [custom]
 * @returns {Promise<{ id: string, creditsUsed: number | null }>}
 */
export async function submitEnrowFindBulk(apiKey, searches, custom = {}) {
    const { body } = await enrowRequest('POST', '/email/find/bulk', apiKey, {
        searches: searches.map((s) => ({
            fullname: s.fullName,
            company_domain: s.domain,
            custom: String(s.contactId)
        })),
        custom
    });
    if (!body?.id) throw new Error('Enrow bulk find returned no id');
    return { id: String(body.id), creditsUsed: numberOrNull(body.credits_used) };
}

/**
 * @param {string} apiKey
 * @param {string[]} emails
 * @param {Record<string, unknown>} [custom]
 * @returns {Promise<{ id: string, creditsUsed: number | null }>}
 */
export async function submitEnrowVerifyBulk(apiKey, emails, custom = {}) {
    const { body } = await enrowRequest('POST', '/email/verify/bulk', apiKey, {
        verifications: emails,
        custom
    });
    if (!body?.id) throw new Error('Enrow bulk verify returned no id');
    return { id: String(body.id), creditsUsed: numberOrNull(body.credits_used) };
}

/**
 * @param {string} apiKey
 * @param {'find' | 'verify'} kind
 * @param {string} id
 */
export async function getEnrowBulk(apiKey, kind, id) {
    const path = kind === 'find' ? '/email/find/bulk' : '/email/verify/bulk';
    const { body } = await enrowRequest('GET', `${path}?id=${encodeURIComponent(id)}`, apiKey);
    return body;
}

/**
 * Launch one Phone Finder search. Credits are charged here, at launch — the GET
 * is free. A LinkedIn URL wins over name + company when both are sent.
 *
 * @param {string} apiKey
 * @param {{ linkedinUrl?: string | null, firstName?: string, lastName?: string, companyDomain?: string, custom?: string }} search
 * @returns {Promise<{ id: string, creditsUsed: number | null }>}
 */
export async function submitEnrowPhoneFind(apiKey, search) {
    const body = {};
    if (search.linkedinUrl) {
        body.linkedin_url = search.linkedinUrl;
    } else {
        // Enrow's field names really are firstname / lastname (no underscore).
        body.firstname = search.firstName;
        body.lastname = search.lastName;
        body.company_domain = search.companyDomain;
    }
    if (search.custom) body.custom = search.custom;
    const { body: res } = await enrowRequest('POST', '/phone/single', apiKey, body);
    if (!res?.id) throw new Error('Enrow phone find returned no id');
    return { id: String(res.id), creditsUsed: numberOrNull(res.credits_used) };
}

/**
 * @param {string} apiKey
 * @param {string} id
 * @returns {Promise<{ qualification: 'found' | 'not_found' | 'ongoing', number: string | null, country: string | null }>}
 */
export async function getEnrowPhone(apiKey, id) {
    const { status, body } = await enrowRequest('GET', `/phone/single?id=${encodeURIComponent(id)}`, apiKey);
    return mapEnrowPhoneResult(status, body);
}

/**
 * 200 + found / not_found, 202 while the search is still running. A `found`
 * without a usable number is treated as not_found rather than stored.
 *
 * @param {number} status
 * @param {object | null} body
 */
export function mapEnrowPhoneResult(status, body) {
    const q = String(body?.qualification || '').toLowerCase();
    if (status === 202 || q === 'ongoing' || !q) {
        return { qualification: 'ongoing', number: null, country: null };
    }
    const number = typeof body?.number === 'string' ? body.number.trim() : '';
    if (q === 'found' && /\d{6,}/.test(number.replace(/\D/g, ''))) {
        const country = typeof body?.country === 'string' && body.country.trim()
            ? body.country.trim().toUpperCase()
            : null;
        return { qualification: 'found', number, country };
    }
    return { qualification: 'not_found', number: null, country: null };
}

function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** `ongoing` | `completed` | `failed` from a bulk GET body. */
export function enrowBulkStatus(body) {
    const status = String(body?.general?.status || '').toLowerCase();
    if (status === 'completed' || status === 'failed') return status;
    return 'ongoing';
}

/**
 * Map a completed bulk-find body onto submitted items. Results carry the
 * per-search `custom` (contact id as a string) and a string `index` into
 * `searches`; custom wins, index is the fallback.
 *
 * @param {object} body
 * @param {Array<{ contact_id: number | string }>} items submit-order items
 * @returns {{ found: Array<{ contactId: string, email: string }>, credits: { initial: number | null, final: number | null } }}
 */
export function mapEnrowFindResults(body, items) {
    const found = [];
    const seen = new Set();
    for (const r of Array.isArray(body?.results) ? body.results : []) {
        if (String(r?.qualification || '').toLowerCase() !== 'valid') continue;
        const email = typeof r.email === 'string' ? r.email.trim() : '';
        if (!email.includes('@')) continue;
        let contactId = r.custom != null && r.custom !== '' ? String(r.custom) : null;
        if (!contactId) {
            const idx = Number.parseInt(String(r.index ?? ''), 10);
            contactId = Number.isFinite(idx) && items[idx] ? String(items[idx].contact_id) : null;
        }
        if (!contactId || seen.has(contactId)) continue;
        seen.add(contactId);
        found.push({ contactId, email });
    }
    const cost = body?.stats?.credits_cost;
    return {
        found,
        credits: {
            initial: numberOrNull(cost?.initial),
            final: numberOrNull(cost?.final)
        }
    };
}

/**
 * Map a completed bulk-verify body onto submitted items. Verify results carry no
 * per-row custom, so they are matched back by (case-insensitive) email.
 *
 * @param {object} body
 * @param {Array<{ contact_id: number | string, email: string }>} items
 * @returns {{ verdicts: Array<{ contactId: string, status: 'valid' | 'invalid' }>, credits: { final: number | null } }}
 */
export function mapEnrowVerifyResults(body, items) {
    const byEmail = new Map();
    for (const item of items) {
        const key = String(item.email || '').trim().toLowerCase();
        if (!key) continue;
        if (!byEmail.has(key)) byEmail.set(key, []);
        byEmail.get(key).push(String(item.contact_id));
    }
    const verdicts = [];
    for (const r of Array.isArray(body?.results) ? body.results : []) {
        const q = String(r?.qualification || '').toLowerCase();
        if (q !== 'valid' && q !== 'invalid') continue;
        const ids = byEmail.get(String(r.email || '').trim().toLowerCase());
        if (!ids) continue;
        for (const contactId of ids) verdicts.push({ contactId, status: q });
    }
    // Bulk verify reports a flat number rather than { initial, refunded, final }.
    const cost = body?.stats?.credits_cost;
    return {
        verdicts,
        credits: { final: numberOrNull(typeof cost === 'object' && cost ? cost.final : cost) }
    };
}
