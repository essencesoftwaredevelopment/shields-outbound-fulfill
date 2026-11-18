/**
 * jobs.options.metaAds = { enabled, minActiveAds, only }
 *   enabled       count active Meta ads for every domain in the run
 *   minActiveAds  skip founder lookup (and everything after) for domains with
 *                 fewer active ads; null = count only, no gate
 *   only          ads-only run: count ads and nothing else, never touching
 *                 the leads' data
 */

/** Sanitize the client payload (string JSON or object). Returns null when off. */
export function sanitizeMetaAdsInput(raw) {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (!value || typeof value !== 'object' || value.enabled !== true) return null;
    const min = Number.parseInt(value.minActiveAds, 10);
    const only = value.only === true;
    return {
        enabled: true,
        minActiveAds: !only && Number.isFinite(min) && min > 0 ? Math.min(min, 1_000_000) : null,
        only
    };
}

/** Normalized options from a stored jobs.options row. */
export function metaAdsOptionsFrom(options = {}) {
    return sanitizeMetaAdsInput(options?.metaAds);
}

/**
 * How the child workflow runs the count:
 *   'off'      not enabled
 *   'only'     ads-only run
 *   'gate'     before founders (the gate needs the count first)
 *   'parallel' alongside founders → emails → verification, so it adds no time
 */
export function metaAdsModeFromOptions(options = {}) {
    const meta = metaAdsOptionsFrom(options);
    if (!meta) return 'off';
    if (meta.only) return 'only';
    if (meta.minActiveAds && !options.skipFounderFinder) return 'gate';
    return 'parallel';
}

/**
 * Pipeline-card state: config + running tally (jobs.options.metaAdsStats).
 * Mirrors lib/pipeline/realtimeRow.ts metaAdsFromOptions. null when off.
 */
export function metaAdsJobState(options = {}) {
    const meta = metaAdsOptionsFrom(options);
    if (!meta) return null;
    const stats = options?.metaAdsStats || {};
    const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    return {
        minActiveAds: meta.minActiveAds,
        only: meta.only,
        counted: count(stats.counted),
        reused: count(stats.reused),
        withAds: count(stats.withAds),
        errors: count(stats.errors),
        gated: count(stats.gated),
        credits: count(stats.credits),
        lastError: typeof stats.lastError === 'string' && stats.lastError ? stats.lastError : null
    };
}
