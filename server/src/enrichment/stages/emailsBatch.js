import { runEmailFinder } from '../../services/emailFinder.js';
import { getEmailFindQueue, getJobById } from '../../services/db/jobs.js';
import { upsertLeadRowsBatch } from '../../services/leads.js';
import { assertJobActive } from '../persist.js';
import { createRateLimitHooks } from '../rateLimit.js';
import { contextToJob } from '../context.js';
import {
    beginJobStage,
    finishJobStage,
    createStageLogger
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
export async function runEmailsBatch(ctx, batchDomains, batchOpts = {}) {
    const batchIndex = batchOpts.batchIndex ?? 0;
    const jobRow = await getJobById(ctx.jobId, ctx.agencyId);
    const stageLog = createStageLogger(ctx, 'emailDiscovery', {
        label: 'emails',
        batchLocalProgress: true,
        batchIndex
    });

    if (ctx.options.skipEmailFinder) {
        await finishJobStage(ctx, 'emailDiscovery', {
            skipped: true,
            imported: batchDomains.length,
            Found: batchDomains.length,
            processed: batchDomains.length
        });
        return { skipped: true };
    }

    const reprocessInclude = enrichmentMergeMode(ctx) === 'enrichment_b';
    // Scoped by batch domains in SQL: a global LIMIT window under parallel child
    // runs could starve this batch while work remained for other domains (§5.2).
    const queue = await getEmailFindQueue(ctx.agencyId, ctx.clientId, ctx.jobId, {
        reprocessInclude,
        limit: batchDomains.length + 500,
        jobStartedAt: jobRow?.created_at || null,
        domains: batchDomains
    });

    if (!queue.length) {
        await finishJobStage(ctx, 'emailDiscovery', { processed: 0, cost: 0 });
        return { processed: 0 };
    }

    await beginJobStage(ctx, 'emailDiscovery', {
        activity: `Email discovery (${queue.length} founders)…`,
        batchIndex
    });

    const founders = queue.map((r) => ({
        domain: r.domain,
        founder_name: r.founder_name
    }));

    const job = contextToJob(ctx);

    const summary = await runEmailFinder({
        founders,
        apiKeys: { ...ctx.apiKeys, kitt: ctx.apiKeys.trykitt },
        log: stageLog,
        job,
        checkpoint: () => assertJobActive(ctx.jobId, ctx.agencyId),
        checkPaused: () => assertJobActive(ctx.jobId, ctx.agencyId),
        pricing: ctx.pricing,
        progressOffset: 0,
        progressTotal: null,
        rateLimitHooks: createRateLimitHooks(ctx),
        onBatch: async (rows) => {
            if (!rows?.length) return;
            await upsertLeadRowsBatch({
                agencyId: ctx.agencyId,
                clientId: ctx.clientId,
                rows,
                type: 'emails',
                jobId: ctx.jobId,
                mergeMode: enrichmentMergeMode(ctx)
            });
        }
    });

    await finishJobStage(ctx, 'emailDiscovery', summary);
    return summary;
}
