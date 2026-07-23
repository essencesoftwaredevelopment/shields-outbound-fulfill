import {
    listPendingJobDomains,
    getEmailFindQueue,
    getVerifyQueue,
    getPersonalizeQueue,
    getJobById
} from '../services/db/jobs.js';

/** Above the 50k-domain design point — resume planning must see every domain. */
const RESUME_PLAN_DOMAIN_LIMIT = 100000;

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
 * Predicates mirror `jobHasRemainingPipelineWork` — keep them in sync.
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
        const queue = await getPersonalizeQueue(ctx.agencyId, ctx.clientId, ctx.jobId, {
            ...limits,
            // Align with the personalization stage's own queue query.
            requireValidEmail: limits.reprocessInclude
        });
        return queue.length > 0;
    }
    return false;
}

/**
 * Domains with remaining queue-stage work (email / verify / personalize) for
 * the resume batch planner. These are domains whose full-pipeline pass already
 * ran (`job_domains.status` beyond 'pending') but whose contacts still have
 * unfinished queue rows — the incident's "146/2,774 verified yet completed"
 * gap. The queue definitions are the same ones `jobHasRemainingPipelineWork`
 * checks, so whatever would keep the job un-finalizable is exactly what gets
 * scheduled into `resumeStagesOnly` batches.
 *
 * @param {import('./context.js').EnrichmentContext} ctx
 * @returns {Promise<string[]>} sorted, de-duplicated domain list
 */
export async function listResumeStageDomainNames(ctx) {
    const { reprocessInclude, jobStartedAt } = await queueLimits(ctx);
    const opts = {
        reprocessInclude,
        jobStartedAt,
        limit: RESUME_PLAN_DOMAIN_LIMIT,
        distinctDomains: true
    };

    const queues = [];
    if (!ctx.options.skipEmailFinder) {
        queues.push(getEmailFindQueue(ctx.agencyId, ctx.clientId, ctx.jobId, opts));
    }
    if (!ctx.options.skipVerification) {
        queues.push(getVerifyQueue(ctx.agencyId, ctx.clientId, ctx.jobId, opts));
    }
    if (ctx.options.personalizeFirstLine) {
        queues.push(getPersonalizeQueue(ctx.agencyId, ctx.clientId, ctx.jobId, {
            ...opts,
            requireValidEmail: reprocessInclude
        }));
    }
    if (!queues.length) return [];

    const rows = (await Promise.all(queues)).flat();
    return [...new Set(rows.map((r) => r.domain).filter(Boolean))].sort();
}
