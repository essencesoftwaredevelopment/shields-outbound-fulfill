import { applyJobControlFileToJob } from './jobControl.js';
import { syncJobControlFromDb } from './db/jobs.js';

export function createJobCancelledError(message = 'Job cancelled') {
    const err = new Error(message);
    err.code = 'JOB_CANCELLED';
    return err;
}

export function createJobPausedError(message = 'Job paused') {
    const err = new Error(message);
    err.code = 'JOB_PAUSED';
    return err;
}

/**
 * Cooperative pause/cancel checkpoints for pipeline stages.
 */
export function createJobControlGate(job, { dbSyncEvery = 5 } = {}) {
    let checkpointCount = 0;

    function applyFileControl() {
        applyJobControlFileToJob(job);
    }

    async function syncDbControl() {
        try {
            await syncJobControlFromDb(job);
        } catch {
            /* noop */
        }
    }

    async function checkpoint() {
        applyFileControl();
        checkpointCount += 1;
        if (checkpointCount % dbSyncEvery === 0) {
            await syncDbControl();
        }
        if (job.cancelled) {
            throw createJobCancelledError('Job cancelled');
        }
        if (job.paused) {
            throw createJobPausedError('Job paused');
        }
    }

    function checkPaused() {
        applyFileControl();
        return !!(job.paused || job.cancelled);
    }

    async function refresh() {
        applyFileControl();
        await syncDbControl();
    }

    return { checkpoint, checkPaused, refresh };
}
