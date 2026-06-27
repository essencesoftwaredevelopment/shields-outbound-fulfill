import { countFinishedLeadsForJob } from '../services/db/jobs.js';
import { computeJobCost } from '../utils/pricing.js';
import { contextToJob } from './context.js';
import { finalizeJobSuccess, finalizeJobError, setJobActivity } from './persist.js';

/**
 * @param {import('./context.js').EnrichmentContext} ctx
 */
export async function runFinalize(ctx) {
    const job = contextToJob(ctx);
    await setJobActivity(ctx.jobId, ctx.agencyId, 'Finalizing job results…');
    const finishedCount = await countFinishedLeadsForJob(ctx.jobId);
    computeJobCost(job);
    await finalizeJobSuccess(ctx.jobId, ctx.agencyId, {
        cost: job.cost || 0,
        finishedCount
    });
    return { finishedCount, cost: job.cost || 0 };
}

export async function runFinalizeError(ctx, error) {
    const message = error?.message || String(error);
    await finalizeJobError(ctx.jobId, ctx.agencyId, message);
    throw error;
}
