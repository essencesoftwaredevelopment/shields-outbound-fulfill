/**
 * Store Leads API client (https://storeleads.app/api).
 *
 * Used by manual lead-bank imports only (see storeLeadsImport.js): the agency
 * buys Store Leads every few months, so nothing here runs on a schedule and a
 * lapsed subscription simply surfaces as STORELEADS_UNAUTHORIZED.
 *
 * - countStoreLeadsDomains: List Domains with page_size=1 → `total`, for the
 *   import preview.
 * - exportStoreLeadsDomains: List Domains with cursor=all&for=jsonl. Store Leads
 *   builds the export asynchronously (HTTP 202 + progress) and we poll the same
 *   URL every 5s until the 200 JSONL body, which is streamed line by line.
 *   cursor=all is limited to 1 request/minute per account.
 * - bulkLookupStoreLeadsDomains: Bulk Retrieve (≤100 domains per call) for
 *   backfilling domains already in the lead bank.
 */

import { normalizeDomain } from '../utils/domain.js';

const STORELEADS_BASE_URL = 'https://storeleads.app/json/api/v1/all';
const MAX_ATTEMPTS = 4;
const INITIAL_BACKOFF_MS = 1000;
const REQUEST_TIMEOUT_MS = 60000;
const EXPORT_POLL_MS = 5000;
/** Give up on an export Store Leads hasn't finished building after this long. */
const EXPORT_MAX_WAIT_MS = 45 * 60 * 1000;
/** Store Leads' documented Bulk Retrieve ceiling. */
export const STORELEADS_BULK_MAX = 100;

/** Only what the lead bank stores; a narrow field list makes exports much faster. */
export const STORELEADS_DOMAIN_FIELDS = [
    'name',
    'aliases',
    'estimated_sales',
    'country_code',
    'platform',
    'plan',
    'state',
    'apps.name',
    'technologies.name'
].join(',');

export const STORELEADS_DOMAIN_STATES = ['Active', 'Inactive', 'Password Protected'];
export const STORELEADS_MAX_SEGMENTS = 3;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function storeLeadsError(status, message) {
    const err = new Error(`Store Leads ${status}: ${message}`);
    err.status = status;
    if (status === 401 || status === 403) {
        err.code = 'STORELEADS_UNAUTHORIZED';
        err.message = `Store Leads rejected the API key (HTTP ${status}). Check the key in the vault and that the Store Leads subscription is active.`;
    }
    return err;
}

function retryAfterMs(res, fallbackMs) {
    const seconds = Number(res.headers.get('retry-after'));
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallbackMs;
}

/**
 * Fetch with retries on network errors, 429 (honouring Retry-After) and 5xx.
 * Returns the raw Response so callers can stream bodies or read 202s.
 *
 * @param {string} url
 * @param {string} apiKey
 * @param {{ method?: 'GET' | 'POST', body?: unknown, timeoutMs?: number }} [options]
 */
async function storeLeadsFetch(url, apiKey, { method = 'GET', body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    if (!apiKey) throw storeLeadsError(401, 'missing API key');
    let backoff = INITIAL_BACKOFF_MS;
    for (let attempt = 1; ; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
            res = await fetch(url, {
                method,
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            });
        } catch (err) {
            clearTimeout(timer);
            if (attempt >= MAX_ATTEMPTS) {
                throw new Error(`Store Leads request failed: ${err?.name === 'AbortError' ? 'timeout' : err?.message || err}`);
            }
            await wait(backoff);
            backoff *= 2;
            continue;
        }
        // The timer only guards headers; streamed bodies are read after this returns.
        clearTimeout(timer);

        if (res.ok) return res;

        const text = await res.text().catch(() => '');
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
            await wait(res.status === 429 ? retryAfterMs(res, 60000) : backoff);
            backoff *= 2;
            continue;
        }
        let message = res.statusText || 'request failed';
        try {
            const parsed = text ? JSON.parse(text) : null;
            message = parsed?.error || parsed?.message || message;
        } catch {
            if (text) message = text.slice(0, 300);
        }
        throw storeLeadsError(res.status, message);
    }
}

function escapeFilterValue(value) {
    return String(value).replace(/,/g, '\\,');
}

function cleanList(values, { upper = false } = {}) {
    if (!Array.isArray(values)) return [];
    const out = [];
    for (const value of values) {
        const text = String(value ?? '').trim();
        if (!text) continue;
        out.push(upper ? text.toUpperCase() : text);
    }
    return [...new Set(out)];
}

function dollarsToCents(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) : null;
}

/**
 * Validate one UI filter segment into a canonical shape. Segments are ANDed
 * internally; several segments are ORed by running one export per segment.
 *
 * @returns {{ segment: object } | { error: string }}
 */
export function normalizeStoreLeadsSegment(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: 'Each filter segment must be an object.' };
    }
    const segment = {
        minMonthlySales: dollarsToCents(raw.minMonthlySales) ? Number(raw.minMonthlySales) : null,
        maxMonthlySales: dollarsToCents(raw.maxMonthlySales) ? Number(raw.maxMonthlySales) : null,
        countries: cleanList(raw.countries, { upper: true }).filter((code) => /^[A-Z]{2}$/.test(code)),
        platforms: cleanList(raw.platforms).map((p) => p.toLowerCase()),
        technologies: cleanList(raw.technologies),
        technologiesMatch: raw.technologiesMatch === 'all' ? 'all' : 'any',
        excludeTechnologies: cleanList(raw.excludeTechnologies),
        states: cleanList(raw.states).filter((state) => STORELEADS_DOMAIN_STATES.includes(state)),
        createdAfter: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.createdAfter || '')) ? String(raw.createdAfter) : null,
        customDomainsOnly: raw.customDomainsOnly !== false
    };
    if (segment.minMonthlySales && segment.maxMonthlySales && segment.minMonthlySales > segment.maxMonthlySales) {
        return { error: 'Minimum monthly sales is above the maximum.' };
    }
    const overlap = segment.technologies.filter((tech) => segment.excludeTechnologies
        .some((excluded) => excluded.toLowerCase() === tech.toLowerCase()));
    if (overlap.length) {
        return { error: `"${overlap[0]}" is both required and excluded.` };
    }
    // Store Leads holds ~14M stores; an unfiltered segment is never intended.
    const hasNarrowingFilter = segment.minMonthlySales || segment.maxMonthlySales || segment.countries.length
        || segment.platforms.length || segment.technologies.length || segment.createdAfter;
    if (!hasNarrowingFilter) {
        return { error: 'Add at least one filter (sales, country, platform, technology or created date).' };
    }
    return { segment };
}

/**
 * Store Leads List Domains query params for a normalized segment.
 * Exported for tests.
 *
 * @returns {Array<[string, string]>}
 */
export function buildStoreLeadsDomainParams(segment) {
    const params = [];
    const minCents = dollarsToCents(segment.minMonthlySales);
    const maxCents = dollarsToCents(segment.maxMonthlySales);
    if (minCents) params.push(['f:ermin', String(minCents)]);
    if (maxCents) params.push(['f:ermax', String(maxCents)]);
    // Multi-value country/platform/state filters are mutually exclusive, so
    // Store Leads needs op=or to mean "any of".
    if (segment.countries.length) {
        params.push(['f:cc', segment.countries.map(escapeFilterValue).join(',')]);
        if (segment.countries.length > 1) params.push(['f:cc:op', 'or']);
    }
    if (segment.platforms.length) {
        params.push(['f:p', segment.platforms.map(escapeFilterValue).join(',')]);
        if (segment.platforms.length > 1) params.push(['f:p:op', 'or']);
    }
    if (segment.states.length) {
        params.push(['f:ds', segment.states.map(escapeFilterValue).join(',')]);
        if (segment.states.length > 1) params.push(['f:ds:op', 'or']);
    }
    // Exclusions are applied after download (segmentExcludesDomain): f:tech
    // takes a single op, and Store Leads documents mixing aq with f: filters
    // inconsistently.
    if (segment.technologies.length) {
        params.push(['f:tech', segment.technologies.map(escapeFilterValue).join(',')]);
        if (segment.technologies.length > 1) {
            params.push(['f:tech:op', segment.technologiesMatch === 'all' ? 'and' : 'or']);
        }
    }
    if (segment.createdAfter) params.push(['f:cratmin', segment.createdAfter]);
    if (segment.customDomainsOnly) params.push(['f:ismy', 'false']);
    return params;
}

function listDomainsUrl(segment, extra) {
    const params = new URLSearchParams(buildStoreLeadsDomainParams(segment));
    for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
    return `${STORELEADS_BASE_URL}/domain?${params.toString()}`;
}

/** True when a mapped domain uses a technology/app the segment excludes. Exported for tests. */
export function segmentExcludesDomain(segment, mapped) {
    if (!segment.excludeTechnologies.length || !mapped) return false;
    const excluded = segment.excludeTechnologies.map((name) => name.toLowerCase());
    return [...mapped.technologies, ...mapped.apps]
        .some((name) => excluded.includes(String(name).toLowerCase()));
}

/**
 * Number of Store Leads domains matching a segment.
 *
 * @returns {Promise<number>}
 */
export async function countStoreLeadsDomains(apiKey, segment) {
    const res = await storeLeadsFetch(listDomainsUrl(segment, { page_size: 1, fields: 'name' }), apiKey);
    const body = await res.json().catch(() => ({}));
    const total = Number(body?.total);
    return Number.isFinite(total) ? total : (Array.isArray(body?.domains) ? body.domains.length : 0);
}

async function* readJsonLines(body) {
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of body) {
        buffered += decoder.decode(chunk, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
            const line = buffered.slice(0, newline).trim();
            buffered = buffered.slice(newline + 1);
            if (line) yield line;
            newline = buffered.indexOf('\n');
        }
    }
    buffered += decoder.decode();
    if (buffered.trim()) yield buffered.trim();
}

/**
 * One-shot export of every domain matching a segment (cursor=all, JSONL).
 *
 * @param {string} apiKey
 * @param {object} segment normalized segment
 * @param {{
 *   onProgress?: (p: { progress: number | null, total: number | null }) => Promise<void> | void,
 *   onDomains: (domains: object[]) => Promise<void>,
 *   chunkSize?: number
 * }} handlers onDomains receives raw Store Leads domain objects in chunks.
 * @returns {Promise<{ received: number }>}
 */
export async function exportStoreLeadsDomains(apiKey, segment, { onProgress, onDomains, chunkSize = 500 }) {
    // Polled with the identical URL: Store Leads ties the 202 progress to it.
    const url = listDomainsUrl(segment, { cursor: 'all', for: 'jsonl', fields: STORELEADS_DOMAIN_FIELDS });

    const startedAt = Date.now();
    let res;
    for (;;) {
        res = await storeLeadsFetch(url, apiKey);
        if (res.status !== 202) break;
        const progressBody = await res.json().catch(() => ({}));
        const progress = Number(progressBody?.progress);
        const total = Number(progressBody?.total);
        await onProgress?.({
            progress: Number.isFinite(progress) ? progress : null,
            total: Number.isFinite(total) ? total : null
        });
        if (Date.now() - startedAt > EXPORT_MAX_WAIT_MS) {
            throw new Error('Store Leads did not finish preparing the export within 45 minutes.');
        }
        await wait(EXPORT_POLL_MS);
    }
    if (!res.body) return { received: 0 };

    let received = 0;
    let chunk = [];
    const flush = async () => {
        if (!chunk.length) return;
        const domains = chunk;
        chunk = [];
        await onDomains(domains);
    };
    for await (const line of readJsonLines(res.body)) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }
        // JSONL lines are domain objects; tolerate a wrapped { domains: [...] } line too.
        const domains = Array.isArray(parsed?.domains) ? parsed.domains : (parsed?.name ? [parsed] : []);
        for (const domain of domains) {
            chunk.push(domain);
            received += 1;
            if (chunk.length >= chunkSize) await flush();
        }
    }
    await flush();
    return { received };
}

/**
 * Bulk Retrieve up to 100 domains. Domains Store Leads doesn't know are simply
 * absent from the response.
 *
 * @returns {Promise<object[]>} raw Store Leads domain objects
 */
export async function bulkLookupStoreLeadsDomains(apiKey, domains) {
    if (!domains.length) return [];
    if (domains.length > STORELEADS_BULK_MAX) {
        throw new Error(`Store Leads bulk lookup takes at most ${STORELEADS_BULK_MAX} domains.`);
    }
    const params = new URLSearchParams({ fields: STORELEADS_DOMAIN_FIELDS });
    const res = await storeLeadsFetch(`${STORELEADS_BASE_URL}/domain/bulk?${params.toString()}`, apiKey, {
        method: 'POST',
        body: { domains }
    });
    const body = await res.json().catch(() => ({}));
    return Array.isArray(body?.domains) ? body.domains : [];
}

function namesOf(list) {
    if (!Array.isArray(list)) return [];
    const names = [];
    for (const item of list) {
        const name = String((typeof item === 'string' ? item : item?.name) || '').trim();
        if (name) names.push(name.slice(0, 200));
    }
    return [...new Set(names)];
}

function textOrNull(value, max = 200) {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, max) : null;
}

/**
 * Map a Store Leads domain object onto lead-bank company fields.
 * Exported for tests.
 */
export function mapStoreLeadsDomain(raw) {
    const domain = normalizeDomain(raw?.name || '');
    if (!domain) return null;
    const cents = Number(raw?.estimated_sales);
    const apps = namesOf(raw?.apps);
    const technologies = namesOf(raw?.technologies);
    const platform = textOrNull(raw?.platform, 80)?.toLowerCase() || null;
    const aliases = Array.isArray(raw?.aliases)
        ? [...new Set(raw.aliases.map((alias) => normalizeDomain(alias)).filter((alias) => alias && alias !== domain))]
        : [];
    return {
        domain,
        aliases,
        estMonthlySalesUsd: Number.isFinite(cents) && cents >= 0 ? Math.round(cents) / 100 : null,
        countryCode: textOrNull(raw?.country_code, 8)?.toUpperCase() || null,
        platform,
        plan: textOrNull(raw?.plan, 120),
        state: textOrNull(raw?.state, 40),
        apps,
        technologies,
        usesKlaviyo: [...apps, ...technologies].some((name) => /klaviyo/i.test(name)),
        usesShopify: platform ? platform === 'shopify' : null
    };
}
