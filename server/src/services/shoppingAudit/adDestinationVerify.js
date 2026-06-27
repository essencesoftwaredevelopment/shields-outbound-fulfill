import axios from 'axios';
import { domainRootLabel, normalizeHostname } from './utils.js';

export const CONTEXT_DEV_SCRAPE_URL = 'https://api.context.dev/v1/web/scrape/html';
export const CONTEXT_DEV_REQUESTS_PER_MINUTE = 120;
const MIN_REQUEST_INTERVAL_MS = Math.ceil(60000 / CONTEXT_DEV_REQUESTS_PER_MINUTE);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serializes Context.dev calls to stay under the per-minute rate limit. */
export class ContextDevRateLimiter {
    constructor() {
        this.chain = Promise.resolve();
        this.lastAt = 0;
    }

    schedule(fn) {
        const run = async () => {
            const wait = Math.max(0, this.lastAt + MIN_REQUEST_INTERVAL_MS - Date.now());
            if (wait) await sleep(wait);
            this.lastAt = Date.now();
            return fn();
        };
        const result = this.chain.then(run);
        this.chain = result.catch(() => {});
        return result;
    }
}

export function urlHostMatchesDomain(url, domain) {
    if (!url || !domain) return false;
    try {
        const host = normalizeHostname(new URL(url).hostname);
        const expected = normalizeHostname(domain);
        const root = domainRootLabel(expected);
        if (!host || !expected) return false;
        if (host === expected || host.endsWith(`.${expected}`)) return true;
        return host.includes(root) && root.length > 2;
    } catch {
        return false;
    }
}

function decodeHtmlEntities(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\\u003d/gi, '=');
}

/**
 * Extract the merchant URL from the Google Shopping "Visit site" button in scraped HTML.
 */
export function extractVisitSiteHref(html) {
    const haystack = String(html || '');
    if (!haystack) return null;

    const anchorRe = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRe.exec(haystack)) !== null) {
        const innerText = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (/visit\s+site/i.test(innerText)) {
            return decodeHtmlEntities(match[1]);
        }
    }

    const jsonMatch = haystack.match(/["']Visit site["']\s*,\s*["'](https?:[^"']+)["']/i);
    if (jsonMatch) {
        return decodeHtmlEntities(jsonMatch[1]);
    }

    return null;
}

/**
 * Check whether the scraped ad destination's "Visit site" button links to the merchant domain.
 */
export function verifyAdDestinationScrape(scrapeResult, domain) {
    if (!scrapeResult?.success) {
        return {
            verified: false,
            finalUrl: null,
            reason: scrapeResult?.error || 'scrape_failed'
        };
    }

    const visitSiteHref = extractVisitSiteHref(scrapeResult.html);
    if (!visitSiteHref) {
        return {
            verified: false,
            finalUrl: scrapeResult.metadata?.finalUrl || scrapeResult.url || null,
            reason: 'visit_site_not_found'
        };
    }

    if (urlHostMatchesDomain(visitSiteHref, domain)) {
        return { verified: true, finalUrl: visitSiteHref, reason: 'visit_site_href' };
    }

    return {
        verified: false,
        finalUrl: visitSiteHref,
        reason: 'visit_site_domain_mismatch'
    };
}

async function scrapeOnce(url, apiKey, { maxAgeMs, timeoutMs }) {
    const response = await axios.get(CONTEXT_DEV_SCRAPE_URL, {
        params: {
            url,
            maxAgeMs,
            timeoutMS: timeoutMs
        },
        headers: {
            Authorization: `Bearer ${apiKey}`
        },
        timeout: timeoutMs + 5000,
        validateStatus: () => true
    });

    if (response.status === 429) {
        const retryAfterSec = parseInt(response.headers['retry-after'], 10);
        const err = new Error('Context.dev rate limited');
        err.status = 429;
        err.retryAfterMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 60000;
        throw err;
    }

    if (response.status !== 200 || !response.data?.success) {
        const message = response.data?.message || `HTTP ${response.status}`;
        return { success: false, error: message, url };
    }

    return {
        success: true,
        url: response.data.url,
        html: response.data.html,
        metadata: response.data.metadata || {},
        type: response.data.type
    };
}

export async function scrapeAdDestinationViaContextDev(
    url,
    apiKey,
    {
        rateLimiter,
        maxAgeMs = 86400000,
        timeoutMs = 20000,
        retries = 2
    } = {}
) {
    if (!url || !apiKey) {
        return { success: false, error: 'missing_url_or_api_key', url: url || null };
    }

    const execute = async () => {
        let lastError = null;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
            try {
                return await scrapeOnce(url, apiKey, { maxAgeMs, timeoutMs });
            } catch (err) {
                lastError = err;
                if (err.status === 429 && attempt < retries) {
                    await sleep(err.retryAfterMs || 60000);
                    continue;
                }
                return {
                    success: false,
                    error: err.message || 'scrape_failed',
                    url
                };
            }
        }
        return { success: false, error: lastError?.message || 'scrape_failed', url };
    };

    if (rateLimiter) {
        return rateLimiter.schedule(execute);
    }
    return execute();
}

export async function verifyAdDestinationUrl(
    adDestinationUrl,
    domain,
    apiKey,
    options = {}
) {
    const scrape = await scrapeAdDestinationViaContextDev(adDestinationUrl, apiKey, options);
    const verdict = verifyAdDestinationScrape(scrape, domain);
    return {
        ...verdict,
        scrapeError: scrape.success ? null : scrape.error
    };
}
