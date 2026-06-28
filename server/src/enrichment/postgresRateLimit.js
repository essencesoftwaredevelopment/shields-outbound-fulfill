import { randomUUID } from 'node:crypto';
import { pool } from '../config/db.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const DEFAULT_RPM = {
    openai: parsePositiveInt(process.env.OPENAI_RPM_LIMIT, 500),
    serper: parsePositiveInt(process.env.SERPER_RPM_LIMIT, 60),
    trykitt: parsePositiveInt(process.env.TRYKITT_RPM_LIMIT, 60)
};

/** Global in-flight Serper batch requests (across all workflow children). */
export const SERPER_MAX_CONCURRENT_BATCHES = parsePositiveInt(
    process.env.SERPER_MAX_CONCURRENT_BATCHES,
    4
);

/**
 * Max concurrent TryKitt calls per agency API key. TryKitt's documented limit is
 * concurrency-based (default 15 simultaneous jobs per key; a 16th returns HTTP 402),
 * NOT requests-per-minute — so a concurrency lease, not an RPM gate, is the correct
 * limiter. find_email and verify_email share this pool. Raise via env once TryKitt
 * lifts the key's cap (they scale it on request when reporting shows you near it).
 */
export const TRYKITT_MAX_CONCURRENT = parsePositiveInt(
    process.env.TRYKITT_MAX_CONCURRENT,
    15
);

const LEASE_TTL_MS = parsePositiveInt(process.env.API_CONCURRENCY_LEASE_TTL_MS, 120_000);
const MAX_ACQUIRE_WAIT_MS = parsePositiveInt(process.env.API_CONCURRENCY_MAX_WAIT_MS, 120_000);
const ACQUIRE_POLL_MS = parsePositiveInt(process.env.API_CONCURRENCY_POLL_MS, 500);

function isPoolExhausted(err) {
    const msg = String(err?.message || err?.code || '');
    return msg.includes('EMAXCONNSESSION')
        || msg.includes('max clients reached')
        || err?.code === 'XX000';
}

async function queryWithPoolRetry(text, params, label) {
    const deadline = Date.now() + 15_000;
    let delay = 100;

    while (Date.now() < deadline) {
        try {
            return await pool.query(text, params);
        } catch (err) {
            if (!isPoolExhausted(err)) throw err;
            await sleep(Math.min(delay, 2000));
            delay = Math.min(delay * 2, 2000);
        }
    }

    throw new Error(`${label}: database pool exhausted after retries`);
}

/** Sliding-window RPM gate — one round-trip via SQL function. */
export async function waitForRateLimitPostgres(agencyId, provider, customRpm) {
    const rpm = customRpm ?? DEFAULT_RPM[provider] ?? 60;
    const key = scopeKey(agencyId, provider);
    const deadline = Date.now() + MAX_ACQUIRE_WAIT_MS;

    while (Date.now() < deadline) {
        const { rows } = await queryWithPoolRetry(
            `SELECT try_record_rate_limit_event($1, $2) AS allowed`,
            [key, rpm],
            `rate limit ${provider}`
        );

        if (rows[0]?.allowed) return;

        await sleep(ACQUIRE_POLL_MS);
    }

    // Transient, not fatal: tagged so the workflow step layer retries it (the rate-limit
    // window clears within ~a minute) instead of failing the whole batch.
    const err = new Error(`Rate limit wait timed out for ${provider} (${rpm}/min)`);
    err.code = 'RATE_LIMIT_TIMEOUT';
    err.retryable = true;
    throw err;
}

export function scopeKey(agencyId, provider) {
    return `${agencyId}:${provider}`;
}

async function tryAcquireConcurrencyLease(scopeKeyValue, leaseId, maxLeases) {
    const { rows } = await queryWithPoolRetry(
        `SELECT try_acquire_api_lease($1, $2, $3, $4) AS acquired`,
        [scopeKeyValue, leaseId, maxLeases, LEASE_TTL_MS],
        `concurrency lease ${scopeKeyValue}`
    );
    return rows[0]?.acquired === true;
}

export async function releaseConcurrencyLease(scopeKeyValue, leaseId) {
    await queryWithPoolRetry(
        `DELETE FROM api_concurrency_leases WHERE scope_key = $1 AND lease_id = $2`,
        [scopeKeyValue, leaseId],
        'release concurrency lease'
    );
}

/** Wait for a concurrency slot, run fn, then release. */
export async function withConcurrencyLease(scopeKeyValue, maxLeases, fn) {
    const leaseId = randomUUID();
    const deadline = Date.now() + MAX_ACQUIRE_WAIT_MS;
    let acquired = false;

    while (Date.now() < deadline) {
        acquired = await tryAcquireConcurrencyLease(scopeKeyValue, leaseId, maxLeases);
        if (acquired) break;
        await sleep(ACQUIRE_POLL_MS);
    }

    if (!acquired) {
        const err = new Error(`Concurrency wait timed out for ${scopeKeyValue} (max ${maxLeases})`);
        err.code = 'CONCURRENCY_TIMEOUT';
        err.retryable = true;
        throw err;
    }

    try {
        return await fn();
    } finally {
        await releaseConcurrencyLease(scopeKeyValue, leaseId).catch(() => {});
    }
}

/**
 * RPM gate + optional concurrency semaphore.
 *
 * @param {object} [opts]
 * @param {number} [opts.customRpm]        Override the provider's default RPM.
 * @param {boolean} [opts.skipRateLimit]   Bypass the sliding-window RPM gate entirely.
 *        Use for providers whose only real limit is concurrency (e.g. TryKitt) so the
 *        lease below is the sole limiter — also avoids a DB round-trip per call.
 * @param {number} [opts.maxConcurrent]    Cap simultaneous in-flight calls via a lease.
 * @param {string} [opts.concurrencyScope] Lease scope key. Defaults to global across all
 *        tenants; pass an agency-scoped key when the limit is per-API-key (e.g. TryKitt).
 */
export async function runWithProviderLimit(agencyId, provider, fn, opts = {}) {
    if (!opts.skipRateLimit) {
        await waitForRateLimitPostgres(agencyId, provider, opts.customRpm);
    }

    const maxConcurrent = opts.maxConcurrent ?? 0;
    if (maxConcurrent > 0) {
        const leaseScope = opts.concurrencyScope || `global:${provider}`;
        return withConcurrencyLease(leaseScope, maxConcurrent, fn);
    }

    return fn();
}
