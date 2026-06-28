import {
    listPendingJobDomains,
    getEmailFindQueue,
    getVerifyQueue,
    getPersonalizeQueue,
    getJobById
} from '../services/db/jobs.js';

function isReprocessInclude(ctx) {
    return String(ctx.options?.dedupeStrategy || 'skip').toLowerCase() === 'include';
}

async function queueLimits(ctx) {
    const row = await getJobById(ctx.jobId, ctx.agencyId);
    return {
        reprocessInclude: isReprocessInclude(ctx),
        limit: 1,
        jobStartedAt: row?.created_at || null
    };
}

/**
 * Whether a pipeline stage still has work left for the whole job (all batches).
 * @param {import('./context.js').EnrichmentContext} ctx
 * @param {string} stageKey
 */
export async function stageHasRemainingWork(ctx, stageKey) {
    const limits = await queueLimits(ctx);

    if (stageKey === 'founders' && !ctx.options.skipFounderFinder) {
        const pending = await listPendingJobDomains(ctx.jobId, 1);
        return pending.length > 0;
    }
    if (stageKey === 'emailDiscovery' && !ctx.options.skipEmailFinder) {
        const queue = await getEmailFindQueue(ctx.agencyId, ctx.clientId, ctx.jobId, limits);
        return queue.length > 0;
    }
    if (stageKey === 'verification' && !ctx.options.skipVerification) {
        const queue = await getVerifyQueue(ctx.agencyId, ctx.clientId, ctx.jobId, limits);
        return queue.length > 0;
    }
    if (stageKey === 'personalization' && ctx.options.personalizeFirstLine) {
        const queue = await getPersonalizeQueue(ctx.agencyId, ctx.clientId, ctx.jobId, limits);
        return queue.length > 0;
    }
    return false;
}
