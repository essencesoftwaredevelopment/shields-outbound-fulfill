import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

type Provider = 'openai' | 'serper' | 'trykitt';

const DEFAULT_RPM: Record<Provider, number> = {
  openai: 500,
  serper: 100,
  trykitt: 60,
};

const limiters = new Map<string, Ratelimit>();

function getLimiter(agencyId: string, provider: Provider, rpm: number) {
  const key = `${agencyId}:${provider}:${rpm}`;
  let limiter = limiters.get(key);
  if (!limiter) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      return null;
    }
    limiter = new Ratelimit({
      redis: new Redis({ url, token }),
      limiter: Ratelimit.slidingWindow(rpm, '1 m'),
      prefix: `enrichment:${provider}`,
    });
    limiters.set(key, limiter);
  }
  return limiter;
}

/** Wait for tenant-scoped rate limit token before external API calls. No-op if Upstash unset. */
export async function waitForRateLimit(
  agencyId: string,
  provider: Provider,
  customRpm?: number
): Promise<void> {
  const rpm = customRpm ?? DEFAULT_RPM[provider];
  const limiter = getLimiter(agencyId, provider, rpm);
  if (!limiter) return;

  const { success, reset } = await limiter.limit(agencyId);
  if (success) return;

  const waitMs = Math.max(0, reset - Date.now());
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 60_000)));
  }
}
