import { fetchActiveAdCount, CONTEXT_DEV_DEFAULT_RPM } from '../../services/metaAds.js';
import {
    listMetaAdsWork,
    loadDomainMetaAds,
    saveMetaAdsResults,
    gateJobDomainsBelowMinAds,
    markMetaAdsOnlyDomainsDone,
    incrementMetaAdsStats
} from '../../services/db/metaAds.js';
import { runWithProviderLimit } from '../postgresRateLimit.js';
import { assertJobActive, setJobActivity } from '../persist.js';
import { createStageLogger } from '../stageProgress.js';
import { metaAdsOptionsFrom } from '../metaAdsOptions.js';

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Requests in flight per batch. The 120/min cap is enforced globally by the
 * Postgres rate gate (shared by every child run of the agency); this only has
 * to keep enough requests open to fill it. A scrape takes ~12–15s (10s page
 * wait), so ~30 in flight saturate 120/min: 10 per child covers a lone batch
 * reasonably and a full wave of children easily.
 */
const CONCURRENCY = parsePositiveInt(process.env.META_ADS_CONCURRENCY, 10);
/** A count younger than this is reused instead of paying for a new scrape. */
const REUSE_DAYS = parsePositiveInt(process.env.META_ADS_REUSE_DAYS, 7);
/** Extra attempts per domain for rate limits, timeouts and unreadable pages. */
const MAX_RETRIES = 2;
const FLUSH_EVERY = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isFresh(row) {
    if (!row?.checked_at || row.active_ads == null) return false;
    const age = Date.now() - new Date(row.checked_at).getTime();
    return age >= 0 && age < REUSE_DAYS * 24 * 60 * 60 * 1000;
}

function missingKeyError() {
    const err = new Error('Meta ad count needs a Context.dev API key. Add it in the API Vault, then resume the job.');
    err.code = 'MISSING_API_KEY';
    return err;
}

/**
 * Count active Meta ads for one batch, then apply the gate (or, for an
 * ads-only run, finish the batch). Idempotent: domains this job already
 * handled are skipped, so step retries and resumes only do what's left.
 *
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {string[]} batchDomains
 * @param {{ batchIndex?: number }} [batchOpts]
 */
export async function runMetaAdsBatch(ctx, batchDomains, batchOpts = {}) {
    const meta = metaAdsOptionsFrom(ctx.options);
    if (!meta) return { skipped: true };

    const apiKey = String(ctx.apiKeys?.contextDev || '').trim();
    if (!apiKey) throw missingKeyError();

    const batchIndex = batchOpts.batchIndex ?? 0;
    const log = createStageLogger(ctx, 'metaAds', { label: 'meta-ads', batchIndex });
    const rpm = Number(ctx.options?.rateLimits?.contextdev) || CONTEXT_DEV_DEFAULT_RPM;

    const todo = await listMetaAdsWork(ctx.jobId, batchDomains);
    const stats = { counted: 0, reused: 0, withAds: 0, errors: 0, gated: 0, credits: 0, lastError: null };

    if (todo.length) {
        await setJobActivity(ctx.jobId, ctx.agencyId, `Counting active Meta ads (${todo.length} domains)…`);

        const stored = await loadDomainMetaAds(ctx.agencyId, todo);
        const pending = [];
        const reused = [];
        for (const domain of todo) {
            const row = stored.get(domain);
            if (isFresh(row)) {
                reused.push({ domain, status: 'reused', activeAds: row.active_ads });
            } else {
                pending.push(domain);
            }
        }
        if (reused.length) {
            await saveMetaAdsResults({ agencyId: ctx.agencyId, jobId: ctx.jobId, results: reused });
            stats.reused += reused.length;
            stats.withAds += reused.filter((r) => r.activeAds > 0).length;
        }

        let buffer = [];
        let flushChain = Promise.resolve();
        const flush = () => {
            const results = buffer;
            buffer = [];
            if (!results.length) return flushChain;
            const delta = {
                counted: results.filter((r) => r.status === 'counted').length,
                withAds: results.filter((r) => r.status === 'counted' && r.activeAds > 0).length,
                errors: results.filter((r) => r.status === 'error').length,
                credits: results.reduce((sum, r) => sum + (r.credits || 0), 0),
                lastError: results.filter((r) => r.status === 'error').map((r) => r.error).pop() || null
            };
            flushChain = flushChain.then(async () => {
                await saveMetaAdsResults({ agencyId: ctx.agencyId, jobId: ctx.jobId, results });
                await incrementMetaAdsStats(ctx.jobId, ctx.agencyId, delta);
            });
            stats.counted += delta.counted;
            stats.withAds += delta.withAds;
            stats.errors += delta.errors;
            stats.credits += delta.credits;
            if (delta.lastError) stats.lastError = delta.lastError;
            return flushChain;
        };

        let fatal = null;
        let next = 0;
        let done = 0;

        const countOne = async (domain) => {
            let credits = 0;
            for (let attempt = 0; ; attempt += 1) {
                try {
                    const result = await runWithProviderLimit(
                        ctx.agencyId,
                        'contextdev',
                        () => fetchActiveAdCount(domain, apiKey),
                        { customRpm: rpm }
                    );
                    return { domain, status: 'counted', activeAds: result.activeAds, credits: credits + result.credits };
                } catch (err) {
                    credits += Number(err?.credits) || 0;
                    if (err?.fatal) throw err;
                    // Our own rate gate timing out is not a domain failure — let
                    // the step retry it (the domain stays unhandled).
                    if (err?.code === 'RATE_LIMIT_TIMEOUT') throw err;
                    if (err?.retryable && attempt < MAX_RETRIES) {
                        await sleep(err.retryAfterMs || 2000 * (attempt + 1));
                        continue;
                    }
                    return { domain, status: 'error', error: err?.message || String(err), credits };
                }
            }
        };

        const worker = async () => {
            while (!fatal && next < pending.length) {
                const domain = pending[next];
                next += 1;
                try {
                    const result = await countOne(domain);
                    buffer.push(result);
                } catch (err) {
                    fatal = fatal || err;
                    return;
                }
                done += 1;
                if (buffer.length >= FLUSH_EVERY) await flush();
                if (done % 10 === 0) {
                    log(`counted ${done}/${pending.length}`);
                    await assertJobActive(ctx.jobId, ctx.agencyId).catch((err) => {
                        fatal = fatal || err;
                    });
                }
            }
        };

        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
        await flush();
        if (fatal) {
            if (fatal.fatal) {
                await incrementMetaAdsStats(ctx.jobId, ctx.agencyId, { lastError: fatal.message }).catch(() => {});
            }
            throw fatal;
        }
        log(`done: ${stats.counted} counted, ${stats.reused} reused, ${stats.errors} failed`);
    }

    if (meta.only) {
        await markMetaAdsOnlyDomainsDone(ctx.jobId, batchDomains);
    } else if (meta.minActiveAds && !ctx.options.skipFounderFinder) {
        stats.gated = await gateJobDomainsBelowMinAds({
            agencyId: ctx.agencyId,
            jobId: ctx.jobId,
            domains: batchDomains,
            minActiveAds: meta.minActiveAds
        });
        if (stats.gated) {
            await incrementMetaAdsStats(ctx.jobId, ctx.agencyId, { gated: stats.gated });
            log(`gated ${stats.gated} domains below ${meta.minActiveAds} active ads`);
        }
    }

    return stats;
}
