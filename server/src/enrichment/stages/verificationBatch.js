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
import { isEnrowEnabled } from './enrowBatch.js';

/**
 * TryKitt emails that stay throttled / timed out are handed to Enrow's verifier
 * only while they are a small share of the batch. A larger share means TryKitt
 * itself is down or throttling the account: keep failing the stage (the job
 * pauses, resumable) rather than paying Enrow to verify everything.
 */
export function enrowHandoffLimit(batchSize) {
    return Math.max(5, Math.ceil(batchSize * 0.1));
}

function enrichmentMergeMode(ctx) {
    return String(ctx.options.dedupeStrategy || 'skip').toLowerCase() === 'include'
        ? 'enrichment_b'
        : 'preserve';
}

const toCandidates = (queue) => queue.map((r) => ({
    domain: r.domain,
    founder_name: r.founder_name,
    email: r.email
}));

/**
 * TryKitt left a few emails unverified (throttle / timeout through its own
 * retries). Give them one more TryKitt pass; whatever is still stuck is stamped
 * 'unknown' so the Enrow re-check that follows this stage verifies it, and the
 * batch continues to Enrow + personalization instead of failing for 1-2 emails.
 */
async function handOffStuckEmailsToEnrow(ctx, { err, verify, batchSize, queueOpts, stageLog }) {
    const stuck = await getVerifyQueue(ctx.agencyId, ctx.clientId, ctx.jobId, queueOpts);
    if (!stuck.length) return { handedToEnrow: 0 };
    if (stuck.length > enrowHandoffLimit(batchSize)) throw err;

    let summary = { handedToEnrow: 0 };
    try {
        summary = await verify(toCandidates(stuck));
    } catch (retryErr) {
        if (retryErr?.code !== 'TRYKITT_THROTTLED') throw retryErr;
    }

    const stillStuck = await getVerifyQueue(ctx.agencyId, ctx.clientId, ctx.jobId, queueOpts);
    if (stillStuck.length) {
        await upsertLeadRowsBatch({
            agencyId: ctx.agencyId,
            clientId: ctx.clientId,
            rows: stillStuck.map((r) => ({
                domain: r.domain,
                founder_name: r.founder_name,
                email: r.email,
                email_status: 'unknown'
            })),
            type: 'verification',
            jobId: ctx.jobId,
            mergeMode: enrichmentMergeMode(ctx),
            reconcileAfterWrite: shouldScheduleChildReconcile(ctx),
            source: 'trykitt'
        });
        stageLog(`Verify: TryKitt timed out twice on ${stillStuck.length} email(s) — marked unknown and passed to Enrow.`);
    }
    return { ...summary, handedToEnrow: stillStuck.length };
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

    const candidates = toCandidates(queue);

    const job = contextToJob(ctx);

    const verify = (candidateRows) => runEmailVerifier({
        candidates: candidateRows,
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
                reconcileAfterWrite: shouldScheduleChildReconcile(ctx),
                source: ctx.options.emailVerificationProvider || 'trykitt'
            });
        }
    });

    let summary;
    try {
        summary = await verify(candidates);
    } catch (err) {
        if (err?.code !== 'TRYKITT_THROTTLED' || !isEnrowEnabled(ctx, 'verify')) throw err;
        summary = await handOffStuckEmailsToEnrow(ctx, {
            err,
            verify,
            batchSize: candidates.length,
            queueOpts: {
                reprocessInclude,
                limit: batchDomains.length + 500,
                jobStartedAt: jobRow?.created_at || null,
                domains: batchDomains
            },
            stageLog
        });
    }

    await finishJobStage(ctx, 'verification', summary);
    return summary;
}
