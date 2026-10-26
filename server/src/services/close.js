/**
 * Close.com API client (https://api.close.com/api/v1) — used as a dialer for
 * positive replies: we create the lead + contact, the team calls from Close.
 *
 * Auth is HTTP Basic with the API key as the username and a blank password.
 * Close rate-limits per key and answers 429 with `rate_reset` (seconds) in the
 * body and a Retry-After header; both are honored, capped so a reply path
 * never stalls for long.
 */

const CLOSE_BASE_URL = 'https://api.close.com/api/v1';
const CLOSE_APP_BASE_URL = 'https://app.close.com';
const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 1000;
const MAX_RATE_WAIT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function closeError(status, message) {
    const err = new Error(`Close ${status}: ${message}`);
    err.status = status;
    if (status === 401 || status === 403) err.code = 'CLOSE_UNAUTHORIZED';
    return err;
}

/** Lead page in the Close app (what Close returns as `html_url`). */
export function closeLeadUrl(leadId) {
    const id = String(leadId || '').trim();
    return id ? `${CLOSE_APP_BASE_URL}/lead/${encodeURIComponent(id)}/` : null;
}

function errorMessage(parsed, fallback) {
    if (!parsed || typeof parsed !== 'object') return fallback;
    if (parsed.error) return typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
    if (parsed['field-errors']) return JSON.stringify(parsed['field-errors']);
    if (Array.isArray(parsed.errors) && parsed.errors.length) return JSON.stringify(parsed.errors);
    return fallback;
}

function rateWaitMs(res, parsed, backoff) {
    const fromBody = Number(parsed?.error?.rate_reset ?? parsed?.rate_reset);
    const fromHeader = Number(res.headers?.get?.('retry-after'));
    const seconds = Number.isFinite(fromBody) && fromBody > 0 ? fromBody
        : Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader
            : null;
    return Math.min(seconds != null ? Math.ceil(seconds * 1000) : backoff, MAX_RATE_WAIT_MS);
}

/**
 * @param {'GET' | 'POST' | 'PUT'} method
 * @param {string} path  e.g. '/lead/'
 * @param {string} apiKey
 * @param {unknown} [body]
 */
export async function closeRequest(method, path, apiKey, body) {
    if (!apiKey) throw closeError(401, 'missing API key');
    const auth = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
    let backoff = INITIAL_BACKOFF_MS;
    for (let attempt = 1; ; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(`${CLOSE_BASE_URL}${path}`, {
                method,
                headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            });
        } catch (err) {
            // A timed-out POST may still have created the lead, so never blind-retry writes.
            if (method !== 'GET' || attempt >= MAX_ATTEMPTS) {
                throw new Error(`Close request failed: ${err?.name === 'AbortError' ? 'timeout' : err?.message || err}`);
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
        if (res.ok) return parsed;

        // 429 is rejected before Close does anything, so it is safe to retry writes too.
        const retryable = res.status === 429 || (res.status >= 500 && method === 'GET');
        if (retryable && attempt < MAX_ATTEMPTS) {
            await wait(res.status === 429 ? rateWaitMs(res, parsed, backoff) : backoff);
            backoff *= 2;
            continue;
        }
        throw closeError(res.status, errorMessage(parsed, res.statusText || 'unknown error'));
    }
}

/**
 * Id of a lead that already has a contact with this email, or null.
 * Advanced Filtering: lead → has contact → has contact_email = email.
 *
 * @param {string} apiKey
 * @param {string} email
 * @returns {Promise<string | null>}
 */
export async function findCloseLeadIdByEmail(apiKey, email) {
    const value = String(email || '').trim().toLowerCase();
    if (!value) return null;
    const body = await closeRequest('POST', '/data/search/', apiKey, {
        query: {
            type: 'and',
            queries: [
                { type: 'object_type', object_type: 'lead' },
                {
                    type: 'has_related',
                    this_object_type: 'lead',
                    related_object_type: 'contact',
                    related_query: {
                        type: 'has_related',
                        this_object_type: 'contact',
                        related_object_type: 'contact_email',
                        related_query: {
                            type: 'field_condition',
                            field: { type: 'regular_field', object_type: 'contact_email', field_name: 'email' },
                            condition: { type: 'text', mode: 'full_words', value }
                        }
                    }
                }
            ]
        },
        _limit: 1
    });
    const id = body?.data?.[0]?.id;
    return id ? String(id) : null;
}

/**
 * @param {string} apiKey
 * @param {string} leadId
 * @returns {Promise<{ id: string, contacts: Array<{ id: string, emails?: Array<{ email: string }>, phones?: Array<{ phone: string, type?: string }> }> }>}
 */
export async function getCloseLead(apiKey, leadId) {
    return closeRequest('GET', `/lead/${encodeURIComponent(leadId)}/?_fields=id,html_url,contacts`, apiKey);
}

/**
 * @param {string} apiKey
 * @param {{
 *   name: string,
 *   url?: string | null,
 *   description?: string | null,
 *   contact: { name?: string | null, title?: string | null, email?: string | null, phone?: string | null }
 * }} lead
 * @returns {Promise<{ leadId: string, contactId: string | null, url: string | null }>}
 */
export async function createCloseLead(apiKey, lead) {
    const c = lead.contact || {};
    const contact = {
        ...(c.name ? { name: c.name } : {}),
        ...(c.title ? { title: c.title } : {}),
        ...(c.email ? { emails: [{ email: c.email, type: 'office' }] } : {}),
        ...(c.phone ? { phones: [{ phone: c.phone, type: 'mobile' }] } : {})
    };
    const body = await closeRequest('POST', '/lead/', apiKey, {
        name: lead.name,
        ...(lead.url ? { url: lead.url } : {}),
        ...(lead.description ? { description: lead.description } : {}),
        contacts: [contact]
    });
    if (!body?.id) throw new Error('Close lead create returned no id');
    return {
        leadId: String(body.id),
        contactId: body.contacts?.[0]?.id ? String(body.contacts[0].id) : null,
        url: body.html_url || closeLeadUrl(body.id)
    };
}

/** Add a contact to an existing lead (the lead matched by email had none for us). */
export async function createCloseContact(apiKey, leadId, contact) {
    const body = await closeRequest('POST', '/contact/', apiKey, {
        lead_id: leadId,
        ...(contact.name ? { name: contact.name } : {}),
        ...(contact.title ? { title: contact.title } : {}),
        ...(contact.email ? { emails: [{ email: contact.email, type: 'office' }] } : {}),
        ...(contact.phone ? { phones: [{ phone: contact.phone, type: 'mobile' }] } : {})
    });
    if (!body?.id) throw new Error('Close contact create returned no id');
    return String(body.id);
}

/**
 * Append a phone to a Close contact, keeping whatever numbers it already has
 * (PUT replaces the whole list). No-op when the number is already there.
 *
 * @returns {Promise<boolean>} whether a write happened
 */
export async function addPhoneToCloseContact(apiKey, contactId, phone) {
    const number = String(phone || '').trim();
    if (!number) return false;
    const current = await closeRequest('GET', `/contact/${encodeURIComponent(contactId)}/?_fields=id,phones`, apiKey);
    const phones = Array.isArray(current?.phones) ? current.phones : [];
    const digits = (v) => String(v || '').replace(/\D/g, '');
    if (phones.some((p) => digits(p.phone) && digits(p.phone).endsWith(digits(number).slice(-9)))) return false;
    await closeRequest('PUT', `/contact/${encodeURIComponent(contactId)}/`, apiKey, {
        phones: [...phones.map((p) => ({ phone: p.phone, type: p.type || 'office' })), { phone: number, type: 'mobile' }]
    });
    return true;
}

/** Plain-text note on the lead (the positive reply, for context before dialing). */
export async function createCloseNote(apiKey, leadId, note) {
    const text = String(note || '').trim();
    if (!text) return null;
    const body = await closeRequest('POST', '/activity/note/', apiKey, { lead_id: leadId, note: text.slice(0, 20_000) });
    return body?.id ? String(body.id) : null;
}
