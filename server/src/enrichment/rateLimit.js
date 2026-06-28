import {
    DEFAULT_RPM,
    SERPER_MAX_CONCURRENT_BATCHES,
    TRYKITT_MAX_CONCURRENT,
    runWithProviderLimit,
    waitForRateLimitPostgres
} from './postgresRateLimit.js';

export { DEFAULT_RPM, SERPER_MAX_CONCURRENT_BATCHES, TRYKITT_MAX_CONCURRENT };

/** Wait for tenant-scoped rate limit before external API calls (Postgres-backed). */
export async function waitForRateLimit(agencyId, provider, customRpm) {
    await waitForRateLimitPostgres(agencyId, provider, customRpm);
}

/**
 * Hooks for stage runners — wrap external API calls.
 * Each hook accepts `() => Promise<T>` and returns `Promise<T>`.
 * @param {import('./context.js').EnrichmentContext} ctx
 */
export function createRateLimitHooks(ctx) {
    const custom = ctx.options?.rateLimits || {};
    return {
        serper: (fn) => runWithProviderLimit(ctx.agencyId, 'serper', fn, {
            customRpm: custom.serper,
            maxConcurrent: SERPER_MAX_CONCURRENT_BATCHES
        }),
        openai: (fn) => runWithProviderLimit(ctx.agencyId, 'openai', fn, {
            customRpm: custom.openai
        }),
        // TryKitt limits per API key by concurrency (default 15 simultaneous jobs;
        // a 16th returns 402), not by RPM. Gate on an agency-scoped lease shared by
        // BOTH email finding and verification, and skip the RPM window entirely.
        trykitt: (fn) => runWithProviderLimit(ctx.agencyId, 'trykitt', fn, {
            skipRateLimit: true,
            maxConcurrent: custom.trykittConcurrency || TRYKITT_MAX_CONCURRENT,
            concurrencyScope: `${ctx.agencyId}:trykitt`
        })
    };
}

/** Call sites that may still use the legacy await-hook() pattern. */
export async function invokeRateLimitHook(hook, fn) {
    if (!hook) return fn();
    return hook(fn);
}
