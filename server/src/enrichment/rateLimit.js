import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const DEFAULT_RPM = {
    openai: 500,
    serper: 100,
    trykitt: 60
};

const limiters = new Map();

function getLimiter(agencyId, provider, rpm) {
    const key = `${agencyId}:${provider}:${rpm}`;
    let limiter = limiters.get(key);
    if (!limiter) {
        const url = process.env.UPSTASH_REDIS_REST_URL;
        const token = process.env.UPSTASH_REDIS_REST_TOKEN;
        if (!url || !token) return null;
        limiter = new Ratelimit({
            redis: new Redis({ url, token }),
            limiter: Ratelimit.slidingWindow(rpm, '1 m'),
            prefix: `enrichment:${provider}`
        });
        limiters.set(key, limiter);
    }
    return limiter;
}

/** Wait for tenant-scoped rate limit before external API calls. No-op if Upstash unset. */
export async function waitForRateLimit(agencyId, provider, customRpm) {
    const rpm = customRpm ?? DEFAULT_RPM[provider] ?? 60;
    const limiter = getLimiter(agencyId, provider, rpm);
    if (!limiter) return;

    const { success, reset } = await limiter.limit(agencyId);
    if (success) return;

    const waitMs = Math.max(0, reset - Date.now());
    if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 60_000)));
    }
}

/**
 * Hooks for stage runners — call before external API requests.
 * @param {import('./context.js').EnrichmentContext} ctx
 */
export function createRateLimitHooks(ctx) {
    const custom = ctx.options?.rateLimits || {};
    return {
        serper: () => waitForRateLimit(ctx.agencyId, 'serper', custom.serper),
        openai: () => waitForRateLimit(ctx.agencyId, 'openai', custom.openai),
        trykitt: () => waitForRateLimit(ctx.agencyId, 'trykitt', custom.trykitt)
    };
}
