/**
 * Postgres-backed rate limiting (used by Vercel workflow steps via server enrichment).
 * Mirrors server/src/enrichment/postgresRateLimit.js — keep defaults in sync.
 */

export const DEFAULT_RPM = {
  openai: 500,
  serper: 60,
  trykitt: 60,
} as const;

export type RateLimitProvider = keyof typeof DEFAULT_RPM;

/** @deprecated Use server enrichment createRateLimitHooks — this module is not imported at runtime. */
export async function waitForRateLimit(
  _agencyId: string,
  _provider: RateLimitProvider,
  _customRpm?: number
): Promise<void> {
  // Implemented in server/src/enrichment/rateLimit.js (Postgres).
}
