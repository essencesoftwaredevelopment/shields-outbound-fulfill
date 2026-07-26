import { runEmailVerifier } from '../../services/emailVerifier.js';
import { getVerifyQueue, getJobById } from '../../services/db/jobs.js';
import { upsertLeadRowsBatch } from '../../services/leads.js';
import { assertJobActive } from '../persist.js';
import { createRateLimitHooks } from '../rateLimit.js';
import { contextToJob } from '../context.js';
import {
    beginJobStage,
    finishJobStage,
    createStageLogger,
    resolveJobTotal,
    batchProgressOffset
} from '../stageProgress.js';
import { shouldScheduleChildReconcile } from '../reconcilePolicy.js';

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
export async function runVerificationBatch(ctx, batchDomains, batchOpts = {}) {
    const batchIndex = batchOpts.batchIndex ?? 0;
    const jobRow = await getJobById(ctx.jobId, ctx.agencyId);
    const jobTotal = resolveJobTotal(ctx) ?? batchDomains.length;
    const progressOffset = batchProgressOffset(batchIndex);
    const stageLog = createStageLogger(ctx, 'verification', {
        label: 'verify',
        jobTotal,
        progressOffset,
        batchIndex
    });

    if (ctx.options.skipVerification) {
        await finishJobStage(ctx, 'verification', { skipped: true });
        return { skipped: true };
    }

    const reprocessInclude = enrichmentMergeMode(ctx) === 'enrichment_b';
    // Scoped by batch domains in SQL: a global LIMIT window under parallel child
    // runs could starve this batch while work remained for other domains (§5.2).
    const queue = await getVerifyQueue(ctx.agencyId, ctx.clientId, ctx.jobId, {
        reprocessInclude,
        limit: batchDomains.length + 500,
        jobStartedAt: jobRow?.created_at || null,
        domains: batchDomains
    });

    if (!queue.length) {
        await finishJobStage(ctx, 'verification', { processed: 0, cost: 0 });
        return { processed: 0 };
    }

    await beginJobStage(ctx, 'verification', {
        activity: `Email verification (${queue.length})…`,
        batchIndex
    });

    const candidates = queue.map((r) => ({
        domain: r.domain,
        founder_name: r.founder_name,
        email: r.email
    }));

    const job = contextToJob(ctx);

    const summary = await runEmailVerifier({
        candidates,
        apiKeys: { ...ctx.apiKeys, kitt: ctx.apiKeys.trykitt },
        provider: ctx.options.emailVerificationProvider || 'trykitt',
        log: stageLog,
        job,
        rateLimitHooks: createRateLimitHooks(ctx),
        checkpoint: () => assertJobActive(ctx.jobId, ctx.agencyId),
        checkPaused: () => assertJobActive(ctx.jobId, ctx.agencyId),
        pricing: ctx.pricing,
        onBatch: async (rows) => {
            if (!rows?.length) return;
            await upsertLeadRowsBatch({
                agencyId: ctx.agencyId,
                clientId: ctx.clientId,
                rows,
                type: 'verification',
                jobId: ctx.jobId,
                mergeMode: enrichmentMergeMode(ctx),
                reconcileAfterWrite: shouldScheduleChildReconcile(ctx)
            });
        }
    });

    await finishJobStage(ctx, 'verification', summary);
    return summary;
}
