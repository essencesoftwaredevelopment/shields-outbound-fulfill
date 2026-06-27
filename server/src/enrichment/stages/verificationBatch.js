import { runEmailVerifier } from '../../services/emailVerifier.js';
import { getVerifyQueue } from '../../services/db/jobs.js';
import { upsertLeadRowsBatch } from '../../services/leads.js';
import { assertJobActive, updateJobStage, setJobActivity } from '../persist.js';
import { contextToJob } from '../context.js';

function enrichmentMergeMode(ctx) {
    return String(ctx.options.dedupeStrategy || 'skip').toLowerCase() === 'include'
        ? 'enrichment_b'
        : 'preserve';
}

function filterToBatch(rows, batchDomains) {
    const batchSet = new Set(batchDomains.map((d) => d.toLowerCase()));
    return rows.filter((r) => batchSet.has(String(r.domain || '').toLowerCase()));
}

/**
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {string[]} batchDomains
 */
export async function runVerificationBatch(ctx, batchDomains) {
    if (ctx.options.skipVerification) {
        await updateJobStage(ctx.jobId, ctx.agencyId, 'verification', {
            status: 'completed',
            completedAt: new Date().toISOString(),
            summary: { skipped: true }
        });
        return { skipped: true };
    }

    const reprocessInclude = enrichmentMergeMode(ctx) === 'enrichment_b';
    const queue = filterToBatch(
        await getVerifyQueue(ctx.agencyId, ctx.clientId, ctx.jobId, {
            reprocessInclude,
            limit: batchDomains.length + 500
        }),
        batchDomains
    );

    if (!queue.length) {
        return { processed: 0 };
    }

    await updateJobStage(ctx.jobId, ctx.agencyId, 'verification', {
        status: 'running',
        startedAt: new Date().toISOString()
    });
    await setJobActivity(ctx.jobId, ctx.agencyId, `Email verification (${queue.length})…`);

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
        log: (msg) => console.log(`[${ctx.jobId}] [verify] ${msg}`),
        job,
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
                mergeMode: enrichmentMergeMode(ctx)
            });
        }
    });

    await updateJobStage(ctx.jobId, ctx.agencyId, 'verification', {
        status: 'completed',
        completedAt: new Date().toISOString(),
        summary
    });

    return summary;
}
