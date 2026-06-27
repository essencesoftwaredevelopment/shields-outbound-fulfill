import { runFounderFinder } from '../../services/founderFinder.js';
import {
    listPendingJobDomains,
    loadSerperCacheMap,
    upsertSerperCacheBatch,
    markJobDomainsDone,
    markJobDomainsFounderExcluded
} from '../../services/db/jobs.js';
import { upsertLeadRowsBatch } from '../../services/leads.js';
import { isNotFoundValue } from '../../services/enrichmentCohort.js';
import { contextToJob } from '../context.js';
import { assertJobActive, updateJobStage, setJobActivity } from '../persist.js';
import { createRateLimitHooks } from '../rateLimit.js';

function enrichmentMergeMode(ctx) {
    return String(ctx.options.dedupeStrategy || 'skip').toLowerCase() === 'include'
        ? 'enrichment_b'
        : 'preserve';
}

/**
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {string[]} batchDomains
 */
export async function runFoundersBatch(ctx, batchDomains) {
    const batchSet = new Set(batchDomains.map((d) => d.toLowerCase()));

    if (ctx.options.skipFounderFinder) {
        const founderCol = ctx.options.columnMapping?.founder || 'founder_name';
        const pending = await listPendingJobDomains(ctx.jobId);
        const inBatch = pending.filter((r) => batchSet.has(r.domain_normalized.toLowerCase()));

        const founderRows = [];
        const excludedDomains = [];
        const doneDomains = [];

        for (const row of inBatch) {
            await assertJobActive(ctx.jobId, ctx.agencyId);
            const raw = row.raw_row || {};
            const founder = String(raw[founderCol] || raw.founder_name || '').trim();
            if (isNotFoundValue(founder)) {
                excludedDomains.push(row.domain_normalized);
                doneDomains.push(row.domain_normalized);
                continue;
            }
            if (founder) {
                founderRows.push({ domain: row.domain_normalized, founder_name: founder });
                doneDomains.push(row.domain_normalized);
            }
        }

        if (excludedDomains.length) {
            await markJobDomainsFounderExcluded(ctx.jobId, excludedDomains);
        }
        if (doneDomains.length) {
            await markJobDomainsDone(ctx.jobId, doneDomains);
        }
        if (founderRows.length) {
            await upsertLeadRowsBatch({
                agencyId: ctx.agencyId,
                clientId: ctx.clientId,
                rows: founderRows,
                type: 'founders',
                jobId: ctx.jobId,
                mergeMode: enrichmentMergeMode(ctx)
            });
        }

        return { processed: founderRows.length, excluded: excludedDomains.length };
    }

    await updateJobStage(ctx.jobId, ctx.agencyId, 'founders', {
        status: 'running',
        startedAt: new Date().toISOString()
    });
    await setJobActivity(ctx.jobId, ctx.agencyId, `Founder lookup (${batchDomains.length} domains)…`);

    const job = contextToJob(ctx);
    const summary = await runFounderFinder({
        domains: batchDomains,
        loadSerperCache: () => loadSerperCacheMap(ctx.jobId),
        saveSerperCache: (entries) => upsertSerperCacheBatch(ctx.jobId, entries),
        markDomainsDone: (domains) => markJobDomainsDone(ctx.jobId, domains),
        checkpoint: () => assertJobActive(ctx.jobId, ctx.agencyId),
        checkPaused: () => assertJobActive(ctx.jobId, ctx.agencyId),
        apiKeys: ctx.apiKeys,
        pricing: ctx.pricing,
        log: (msg, meta) => console.log(`[${ctx.jobId}] [founders] ${msg}`, meta || ''),
        onBatch: async (rows) => {
            if (!rows?.length) return;
            await upsertLeadRowsBatch({
                agencyId: ctx.agencyId,
                clientId: ctx.clientId,
                rows,
                type: 'founders',
                jobId: ctx.jobId,
                mergeMode: enrichmentMergeMode(ctx)
            });
        },
        totalDomainCount: batchDomains.length,
        rateLimitHooks: createRateLimitHooks(ctx)
    });

    await updateJobStage(ctx.jobId, ctx.agencyId, 'founders', {
        status: 'completed',
        completedAt: new Date().toISOString(),
        summary
    });

    return summary;
}
