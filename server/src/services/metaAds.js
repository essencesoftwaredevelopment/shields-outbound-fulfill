import axios from 'axios';

/**
 * Active Meta ad count for a domain, read from Meta's Ad Library via
 * Context.dev's scraper.
 *
 * We load the Ad Library search for the domain as an exact phrase (active ads,
 * all countries) and read the "~N results" figure at the top of the page.
 * Meta's number is approximate, and it counts every active ad whose text
 * contains the domain, including ads by other advertisers that mention it.
 */

export const CONTEXT_DEV_SCRAPE_ENDPOINT = 'https://api.context.dev/v1/web/scrape';
/** Context.dev's per-key limit. Concurrency is unlimited; this is the only cap. */
export const CONTEXT_DEV_DEFAULT_RPM = 120;

/** Meta renders results client-side; 10s matched the manual tests. */
const PAGE_WAIT_MS = 10_000;
const REQUEST_DEADLINE_MS = 45_000;

export function buildAdLibraryUrl(domain) {
    const params = new URLSearchParams({
        active_status: 'active',
        ad_type: 'all',
        country: 'ALL',
        is_targeted_country: 'false',
        media_type: 'all',
        q: `"${domain}"`,
        search_type: 'keyword_exact_phrase'
    });
    return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

const NO_RESULTS_RE = /No ads match your search criteria/i;
// "~36 results", "\~1,600 results", "1 result", "~1.2K results", "50,000+ results"
const RESULTS_RE = /(?:^|\n)[ \t]*\\?~?[ \t]*(\d[\d,. ]*)[ \t]*([KkMm])?\+?[ \t]+results?\b/;

/**
 * @param {string} markdown
 * @returns {number | null} active ad count, or null when the page shows neither
 *   a result count nor Meta's "no ads" message (blocked, login wall, not
 *   rendered). Never read null as 0.
 */
export function parseActiveAdCount(markdown) {
    const text = String(markdown || '');
    const match = text.match(RESULTS_RE);
    if (match) {
        const multiplier = match[2] ? (/k/i.test(match[2]) ? 1_000 : 1_000_000) : 1;
        const raw = match[1].replace(/[ ,]/g, '');
        const value = multiplier === 1 ? Number.parseInt(raw.replace(/\./g, ''), 10) : Number.parseFloat(raw);
        if (Number.isFinite(value)) return Math.round(value * multiplier);
    }
    if (NO_RESULTS_RE.test(text)) return 0;
    if (/(?:^|\n)[ \t]*0[ \t]+results\b/.test(text)) return 0;
    return null;
}

function contextDevError(message, { status = null, code = null, retryable = false, fatal = false, retryAfterMs = null } = {}) {
    const err = new Error(message);
    err.status = status;
    err.code = code;
    err.retryable = retryable;
    // Fatal: every further request would fail the same way (bad key, no credits).
    err.fatal = fatal;
    if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
    return err;
}

/**
 * One scrape. Resolves `{ activeAds, credits }`; throws an error tagged
 * `retryable` (rate limit, timeout, outage, unreadable page) or `fatal`
 * (invalid key, out of credits).
 *
 * @param {string} domain
 * @param {string} apiKey
 */
export async function fetchActiveAdCount(domain, apiKey) {
    let response;
    try {
        response = await axios.post(
            CONTEXT_DEV_SCRAPE_ENDPOINT,
            {
                url: buildAdLibraryUrl(domain),
                formats: { markdown: true },
                markdownParams: { includeLinks: false },
                maxAgeMs: 0,
                sharedParams: { waitFor: PAGE_WAIT_MS },
                timeoutOpts: { milliseconds: REQUEST_DEADLINE_MS, behavior: 'fail' },
                tags: ['meta-ad-count']
            },
            {
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                timeout: REQUEST_DEADLINE_MS + 15_000,
                validateStatus: () => true
            }
        );
    } catch (err) {
        throw contextDevError(`Context.dev request failed: ${err?.message || err}`, { retryable: true });
    }

    const { status, data } = response;
    const apiMessage = data?.message || data?.error_code || `HTTP ${status}`;
    if (status === 429) {
        const retryAfterSec = Number.parseInt(response.headers?.['retry-after'], 10);
        throw contextDevError('Context.dev rate limited', {
            status,
            code: 'RATE_LIMITED',
            retryable: true,
            retryAfterMs: Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 15_000
        });
    }
    if (status === 402 || data?.error_code === 'USAGE_EXCEEDED') {
        throw contextDevError('Context.dev is out of credits. Top up, then resume the job.', {
            status,
            code: 'CREDIT_EXHAUSTED',
            fatal: true
        });
    }
    if (status === 401 || status === 403) {
        throw contextDevError(`Context.dev rejected the API key (${apiMessage}). Check it in the API Vault.`, {
            status,
            code: 'INVALID_KEY',
            fatal: true
        });
    }
    if (status === 408 || status >= 500) {
        throw contextDevError(`Context.dev ${status === 408 ? 'timed out' : 'error'}: ${apiMessage}`, {
            status,
            retryable: true
        });
    }
    if (status !== 200) {
        throw contextDevError(`Context.dev ${apiMessage}`, { status });
    }

    const credits = Number(data?.key_metadata?.credits_consumed) || 0;
    if (data?.markdown?.success === false) {
        throw Object.assign(
            contextDevError(`Page not scraped: ${data.markdown.message || data.markdown.error_code || 'unknown'}`, {
                retryable: true
            }),
            { credits }
        );
    }
    const markdown = typeof data?.markdown === 'string' ? data.markdown : data?.markdown?.data;
    const activeAds = parseActiveAdCount(markdown);
    if (activeAds === null) {
        throw Object.assign(
            contextDevError('Ad Library page had no result count (blocked or not rendered)', { retryable: true }),
            { credits }
        );
    }
    return { activeAds, credits };
}
