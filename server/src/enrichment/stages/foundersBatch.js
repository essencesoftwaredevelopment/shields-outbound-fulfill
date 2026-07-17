import { runFounderFinder } from '../../services/founderFinder.js';
import {
    listPendingJobDomains,
    loadSerperCacheMap,
    upsertSerperCacheBatch,
    markJobDomainsDone,
    getJobById
} from '../../services/db/jobs.js';
import { upsertLeadRowsBatch, upsertFounderSearchBatch } from '../../services/leads.js';
import { isNotFoundValue } from '../../services/enrichmentCohort.js';
import { contextToJob } from '../context.js';
import { assertJobActive } from '../persist.js';
import { createRateLimitHooks } from '../rateLimit.js';
import {
    beginJobStage,
    finishJobStage,
    createStageLogger,
    resolveJobTotal,
    batchProgressOffset
} from '../stageProgress.js';

function enrichmentMergeMode(ctx) {
    return String(ctx.options.dedupeStrategy || 'skip').toLowerCase() === 'include'
        ? 'enrichment_b'
        : 'preserve';
}

/**
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {string[]} batchDomains
 * @param {{ batchIndex?: number }} [batchOpts]
 */
export async function runFoundersBatch(ctx, batchDomains, batchOpts = {}) {
    const batchIndex = batchOpts.batchIndex ?? 0;
    const batchSet = new Set(batchDomains.map((d) => d.toLowerCase()));
    const jobTotal = resolveJobTotal(ctx);
    const progressOffset = batchProgressOffset(batchIndex);
    const stageLog = createStageLogger(ctx, 'founders', {
        label: 'founders',
        jobTotal,
        progressOffset,
        batchIndex
    });

    if (ctx.options.skipFounderFinder) {
        // Empty string must NOT fall back to 'founder_name' — an unmapped founder
        // column means pass-through (contacts already exist / verify-only jobs).
        const founderCol = String(ctx.options.columnMapping?.founder || '').trim();
        const pending = await listPendingJobDomains(ctx.jobId);
        const inBatch = pending.filter((r) => batchSet.has(r.domain_normalized.toLowerCase()));

        const founderRows = [];
        const excludedDomains = [];
        const doneDomains = [];

        for (const row of inBatch) {
            await assertJobActive(ctx.jobId, ctx.agencyId);
            const raw = row.raw_row || {};

            if (!founderCol) {
                // No founder column mapped: mark done without inventing "Not Found"
                // exclusions that would empty the verify queue.
                doneDomains.push(row.domain_normalized);
                continue;
            }

            const founder = String(raw[founderCol] ?? '').trim();
            if (isNotFoundValue(founder)) {
                excludedDomains.push(row.domain_normalized);
                founderRows.push({ domain: row.domain_normalized, founder_name: '' });
                doneDomains.push(row.domain_normalized);
                continue;
            }
            founderRows.push({ domain: row.domain_normalized, founder_name: founder });
            doneDomains.push(row.domain_normalized);
        }

        if (doneDomains.length) {
            await markJobDomainsDone(ctx.jobId, doneDomains);
        }
        if (founderRows.length) {
            await upsertFounderSearchBatch({
                agencyId: ctx.agencyId,
                clientId: ctx.clientId,
                rows: founderRows,
                jobId: ctx.jobId,
                mergeMode: enrichmentMergeMode(ctx)
            });
        }

        const summary = {
            processed: founderRows.length + (founderCol ? 0 : doneDomains.length),
            excluded: excludedDomains.length,
            Found: founderRows.filter((r) => r.founder_name).length,
            imported: founderRows.filter((r) => r.founder_name).length,
            cost: 0
        };
        await finishJobStage(ctx, 'founders', summary);
        return summary;
    }

    await beginJobStage(ctx, 'founders', {
        activity: `Founder lookup (${batchDomains.length} domains)…`,
        batchIndex
    });

    const summary = await runFounderFinder({
        domains: batchDomains,
        loadSerperCache: () => loadSerperCacheMap(ctx.jobId),
        saveSerperCache: (entries) => upsertSerperCacheBatch(ctx.jobId, entries),
        markDomainsDone: (domains) => markJobDomainsDone(ctx.jobId, domains),
        checkpoint: () => assertJobActive(ctx.jobId, ctx.agencyId),
        jobId: ctx.jobId,
        agencyId: ctx.agencyId,
        apiKeys: ctx.apiKeys,
        pricing: ctx.pricing,
        log: stageLog,
        onBatch: async (rows) => {
            if (!rows?.length) return;
            await upsertFounderSearchBatch({
                agencyId: ctx.agencyId,
                clientId: ctx.clientId,
                rows,
                jobId: ctx.jobId,
                mergeMode: enrichmentMergeMode(ctx)
            });
        },
        totalDomainCount: jobTotal || batchDomains.length,
        rateLimitHooks: createRateLimitHooks(ctx)
    });

    await finishJobStage(ctx, 'founders', summary);
    return summary;
}
