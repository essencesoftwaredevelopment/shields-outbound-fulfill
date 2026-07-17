import { countFinishedLeadsForJob, getJobById } from '../services/db/jobs.js';
import { computeJobCost } from '../utils/pricing.js';
import { contextToJob } from './context.js';
import {
    finalizeJobSuccess,
    finalizeJobError,
    setJobActivity,
    getJobControlFlags,
    finalizeWorkflowError,
    finalizeWorkflowCancelled,
    finalizeWorkflowPaused
} from './persist.js';
import { syncStagesBeforeFinalize } from './stageProgress.js';
import { reconcileJobStagesFromDb } from './reconcileStageCounts.js';

/**
 * @param {import('./context.js').EnrichmentContext} ctx
 */
export async function runFinalize(ctx) {
    await setJobActivity(ctx.jobId, ctx.agencyId, 'Finalizing job results…');

    await syncStagesBeforeFinalize(ctx.jobId, ctx.agencyId);
    const reconciledStages = await reconcileJobStagesFromDb(ctx);
    const row = await getJobById(ctx.jobId, ctx.agencyId);
    const job = contextToJob({ ...ctx, stages: reconciledStages || row?.stages });
    const finishedCount = await countFinishedLeadsForJob(ctx.jobId);

    const { getJobStageCosts } = await import('../services/db/jobStageCosts.js');
    const stageCosts = await getJobStageCosts(ctx.jobId);
    const ledgerTotal = Object.values(stageCosts).reduce((sum, n) => sum + (Number(n) || 0), 0);
    const cost = ledgerTotal > 0
        ? Number(ledgerTotal.toFixed(6))
        : (Number(row?.cost) > 0 ? Number(row.cost) : computeJobCost(job));

    await finalizeJobSuccess(ctx.jobId, ctx.agencyId, {
        cost: cost || 0,
        finishedCount
    });
    return { finishedCount, cost: cost || 0 };
}

export async function runFinalizeError(ctx, error) {
    const message = error?.message || String(error);
    await finalizeJobError(ctx.jobId, ctx.agencyId, message);
    throw error;
}

/**
 * Centralized failure handler for the Vercel workflow runner.
 *
 * Without this, an uncaught throw anywhere in the parent/child workflow leaves the
 * job stuck at `status='running'` with no error recorded — a silent zombie that only
 * a manual resume can recover. This resolves the job's terminal state instead.
 *
 * Disposition is driven by the DB control flags, which are authoritative: an Error's
 * custom `.code` (JOB_PAUSED / JOB_CANCELLED) may not survive serialization across the
 * workflow step boundary, but `jobs.cancelled` / `jobs.paused` always reflect intent.
 * A real error never sets `jobs.paused`, so a truthy paused flag reliably means the
 * user paused (graceful stop) rather than a failure.
 *
 * @param {string} jobId
 * @param {string} agencyId
 * @param {{ message?: string | null, code?: string | null }} [errorInfo]
 * @returns {Promise<{ disposition: 'cancelled' | 'paused' | 'error' }>}
 */
export async function handleWorkflowFailure(jobId, agencyId, errorInfo = {}) {
    const { message = null, code = null } = errorInfo || {};

    let flags = { cancelled: false, paused: false };
    try {
        flags = await getJobControlFlags(jobId, agencyId);
    } catch {
        // Flags unreadable (e.g. DB blip) — fall through to the error disposition,
        // which is the safe default: record the failure and keep the job resumable.
    }

    const disposition = resolveWorkflowFailureDisposition(flags, code);

    if (disposition === 'cancelled') {
        await finalizeWorkflowCancelled(jobId, agencyId);
    } else if (disposition === 'paused') {
        await finalizeWorkflowPaused(jobId, agencyId);
    } else {
        await finalizeWorkflowError(jobId, agencyId, message || 'Workflow failed');
    }

    return { disposition };
}

/**
 * Pure decision: given the DB control flags (authoritative) and the error code (hint),
 * what terminal state should a failed workflow run resolve to?
 *
 * Precedence: cancel > pause > error. A real error never sets `jobs.paused`, so a
 * truthy paused flag reliably means a graceful user pause rather than a failure.
 *
 * @param {{ cancelled?: boolean, paused?: boolean }} flags
 * @param {string | null} [code]
 * @returns {'cancelled' | 'paused' | 'error'}
 */
export function resolveWorkflowFailureDisposition(flags = {}, code = null) {
    if (flags.cancelled || code === 'JOB_CANCELLED') return 'cancelled';
    if (flags.paused || code === 'JOB_PAUSED') return 'paused';
    return 'error';
}
