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

export async function finalizeJobSuccess(jobId, agencyId, { cost = 0, finishedCount = 0 } = {}) {
    await pool.query(
        `UPDATE jobs SET
            status = 'completed',
            completed_at = NOW(),
            cost = $3,
            is_active = false,
            options = COALESCE(options, '{}'::jsonb) || $4::jsonb,
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

export async function guardWorkflowStart(jobId, agencyId) {
    const row = await getJobById(jobId, agencyId);
    if (!row) throw new Error('Job not found');
    if (row.status === 'running' && row.options?.workflowRunId) {
        throw new Error('Job already running on Vercel Workflows');
    }
    if (row.status === 'completed') {
        throw new Error('Job already completed');
    }
}
