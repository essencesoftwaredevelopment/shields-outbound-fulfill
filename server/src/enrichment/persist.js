import { pool } from '../config/db.js';
import { getJobById } from '../services/db/jobs.js';

export async function getJobControlFlags(jobId, agencyId) {
    const row = await getJobById(jobId, agencyId);
    if (!row) return { cancelled: true, paused: false };
    return { cancelled: !!row.cancelled, paused: !!row.paused };
}

export async function assertJobActive(jobId, agencyId) {
    const flags = await getJobControlFlags(jobId, agencyId);
    if (flags.cancelled) {
        const err = new Error('Job cancelled');
        err.code = 'JOB_CANCELLED';
        throw err;
    }
    if (flags.paused) {
        const err = new Error('Job paused');
        err.code = 'JOB_PAUSED';
        throw err;
    }
}

/**
 * @param {string} jobId
 * @param {string} agencyId
 * @param {string | null} [workflowRunId]
 */
export async function markJobRunning(jobId, agencyId, workflowRunId = null) {
    await pool.query(
        `UPDATE jobs SET status = 'running', updated_at = NOW(),
         options = COALESCE(options, '{}'::jsonb) || $3::jsonb
         WHERE id = $1 AND agency_id = $2`,
        [
            jobId,
            agencyId,
            JSON.stringify({
                ...(workflowRunId ? { workflowRunId } : {}),
                executionRunner: 'vercel'
            })
        ]
    );
}

export async function setWorkflowMeta(jobId, agencyId, patch = {}) {
    await pool.query(
        `UPDATE jobs SET
            options = COALESCE(options, '{}'::jsonb) || $3::jsonb,
            updated_at = NOW()
         WHERE id = $1 AND agency_id = $2`,
        [jobId, agencyId, JSON.stringify(patch)]
    );
}

export async function updateJobStage(jobId, agencyId, stageKey, patch) {
    const row = await getJobById(jobId, agencyId);
    if (!row) return;
    const stages = { ...(row.stages || {}) };
    stages[stageKey] = { ...(stages[stageKey] || {}), ...patch };
    await pool.query(
        `UPDATE jobs SET stages = $3::jsonb, updated_at = NOW() WHERE id = $1 AND agency_id = $2`,
        [jobId, agencyId, JSON.stringify(stages)]
    );
}

export async function setJobActivity(jobId, agencyId, message) {
    await pool.query(
        `UPDATE jobs SET
            options = COALESCE(options, '{}'::jsonb) || $3::jsonb,
            updated_at = NOW()
         WHERE id = $1 AND agency_id = $2`,
        [
            jobId,
            agencyId,
            JSON.stringify({
                activityMessage: message,
                activityUpdatedAt: new Date().toISOString()
            })
        ]
    );
}

/**
 * Cheap liveness ping for the stall reaper.
 *
 * Vercel child batches no longer run live reconciles (see `reconcilePolicy.js`),
 * and `jobs.updated_at` is what `reapStalledWorkflows` uses to decide a job is
 * dead. Its second signal — "no `api_rate_limit_events` in 90s" — is not a
 * reliable fallback: TryKitt runs concurrency-only whenever no per-agency RPM is
 * configured (`DEFAULT_RPM.trykitt` is null), so `runWithProviderLimit` skips the
 * RPM gate and writes no events at all. A wave sitting in a long verification
 * stage would then look dead on both signals and be reaped mid-flight.
 *
 * One indexed UPDATE by primary key, throttled by the caller — no cohort scan.
 */
export async function touchJobHeartbeat(jobId, agencyId) {
    await pool.query(
        `UPDATE jobs SET updated_at = NOW() WHERE id = $1 AND agency_id = $2`,
        [jobId, agencyId]
    );
}

export async function finalizeJobSuccess(jobId, agencyId, { cost = 0, finishedCount = 0 } = {}) {
    // error = NULL: a successfully finalized job must not keep showing a stale
    // stall/pause message (incident §5.5). The autoResumeAttempts counter also
    // resets here so the next stall gets a fresh auto-resume budget.
    await pool.query(
        `UPDATE jobs SET
            status = 'completed',
            completed_at = NOW(),
            cost = $3,
            is_active = false,
            error = NULL,
            options = (COALESCE(options, '{}'::jsonb) - 'autoResumeAttempts') || $4::jsonb,
            updated_at = NOW()
         WHERE id = $1 AND agency_id = $2`,
        [
            jobId,
            agencyId,
            cost,
            JSON.stringify({
                activityMessage: `${finishedCount} leads ready for export`,
                activityUpdatedAt: new Date().toISOString()
            })
        ]
    );
    await pool.query(
        `UPDATE job_queue SET status = 'completed', updated_at = NOW(), completed_at = NOW()
         WHERE job_id = $1`,
        [jobId]
    );
}

export async function finalizeJobError(jobId, agencyId, errorMessage) {
    await pool.query(
        `UPDATE jobs SET status = 'paused', error = $3, updated_at = NOW()
         WHERE id = $1 AND agency_id = $2`,
        [jobId, agencyId, errorMessage]
    );
    await pool.query(
        `UPDATE job_queue SET status = 'failed', error = $2, updated_at = NOW()
         WHERE job_id = $1`,
        [jobId, errorMessage]
    );
}

/**
 * Vercel workflow runner hit a real (non-pause/cancel) error.
 *
 * Leaves the job recoverable and resumable: mirrors the PM2 `pauseJobWithError`
 * convention (paused=true + error recorded, status kept 'running') so the existing
 * resume route — which gates on `jobs.paused` — can pick it back up. We deliberately
 * do NOT use `finalizeJobError` here: it sets status='paused' WITHOUT the paused flag,
 * which the resume guard at routes/jobs.js treats as un-resumable.
 */
export async function finalizeWorkflowError(jobId, agencyId, errorMessage) {
    const message = errorMessage || 'Workflow failed';
    await pool.query(
        `UPDATE jobs SET
            paused = true,
            paused_at = NOW(),
            cancelled = false,
            error = $3,
            options = COALESCE(options, '{}'::jsonb) || $4::jsonb,
            updated_at = NOW()
         WHERE id = $1 AND agency_id = $2`,
        [
            jobId,
            agencyId,
            message,
            JSON.stringify({
                activityMessage: message,
                activityUpdatedAt: new Date().toISOString()
            })
        ]
    );
    await pool.query(
        `UPDATE job_queue SET status = 'paused', error = $2, updated_at = NOW() WHERE job_id = $1`,
        [jobId, message]
    );
}

/** Vercel workflow stopped because the job was cancelled — mirror PM2 markCancelled. */
export async function finalizeWorkflowCancelled(jobId, agencyId, reason = 'Cancelled during processing') {
    await pool.query(
        `UPDATE jobs SET
            status = 'failed',
            cancelled = true,
            paused = false,
            error = $3,
            completed_at = COALESCE(completed_at, NOW()),
            updated_at = NOW()
         WHERE id = $1 AND agency_id = $2`,
        [jobId, agencyId, reason]
    );
    await pool.query(
        `UPDATE job_queue SET status = 'cancelled', updated_at = NOW() WHERE job_id = $1`,
        [jobId]
    );
}

/** Vercel workflow stopped because the user paused — graceful stop, keep resumable. */
export async function finalizeWorkflowPaused(jobId, agencyId) {
    await pool.query(
        `UPDATE jobs SET paused = true, paused_at = NOW(), cancelled = false, updated_at = NOW()
         WHERE id = $1 AND agency_id = $2`,
        [jobId, agencyId]
    );
    await pool.query(
        `UPDATE job_queue SET status = 'paused', updated_at = NOW() WHERE job_id = $1`,
        [jobId]
    );
}

export async function isStageComplete(jobId, agencyId, stageKey) {
    const row = await getJobById(jobId, agencyId);
    return row?.stages?.[stageKey]?.status === 'completed';
}

export async function runStageIfComplete(
    jobId,
    agencyId,
    stageKey,
    handler,
    { skipResult = null } = {}
) {
    if (await isStageComplete(jobId, agencyId, stageKey)) {
        return skipResult;
    }
    return handler();
}

export async function clearWorkflowRunId(jobId) {
    await pool.query(
        `UPDATE jobs SET
            options = COALESCE(options, '{}'::jsonb) - 'workflowRunId',
            updated_at = NOW()
         WHERE id = $1`,
        [jobId]
    );
}

/**
 * Rejection messages thrown by guardWorkflowStart. The parent workflow catch
 * matches these EXACT strings to end a duplicate run without touching job
 * state (a custom error `code` does not survive the workflow step
 * serialization boundary — only the message does). Mirrored in
 * `lib/enrichment/startRejection.ts`; a unit test pins them in sync.
 */
export const START_REJECTION_ALREADY_RUNNING = 'Job already running on Vercel Workflows';
export const START_REJECTION_ALREADY_COMPLETED = 'Job already completed';

export async function guardWorkflowStart(jobId, agencyId) {
    const row = await getJobById(jobId, agencyId);
    if (!row) throw new Error('Job not found');
    const existingRunId = row.options?.workflowRunId;
    if (row.status === 'running' && existingRunId && !row.paused) {
        const err = new Error(START_REJECTION_ALREADY_RUNNING);
        err.code = 'WORKFLOW_ALREADY_RUNNING';
        throw err;
    }
    if (row.status === 'completed') {
        const { jobHasRemainingPipelineWork } = await import('../services/db/jobs.js');
        const options = row.options || {};
        const hasRemaining = await jobHasRemainingPipelineWork({
            agencyId,
            clientId: row.client_id,
            jobId,
            skipEmailFinder: !!options.skipEmailFinder,
            skipVerification: !!options.skipVerification,
            personalizeFirstLine: !!options.personalizeFirstLine,
            dedupeStrategy: options.dedupeStrategy || 'skip',
            jobStartedAt: row.created_at ? new Date(row.created_at).toISOString() : null
        });
        if (!hasRemaining) {
            const err = new Error(START_REJECTION_ALREADY_COMPLETED);
            err.code = 'WORKFLOW_ALREADY_COMPLETED';
            throw err;
        }
    }
}
