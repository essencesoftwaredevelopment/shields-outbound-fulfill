import { applyJobControlFileToJob } from './jobControl.js';
import { syncJobControlFromDb } from './db/jobs.js';

/** Refresh pause/cancel flags from control file + DB (when refresh is provided). */
export async function refreshJobControlFlags(job, refresh, checkPaused) {
    if (typeof refresh === 'function') {
        await refresh();
    } else if (typeof checkPaused === 'function') {
        checkPaused();
    } else if (job?.id) {
        applyJobControlFileToJob(job);
    }
    return !!(job?.paused || job?.cancelled);
}

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
 * After cooperative stop (pause/cancel), throw the correct control error.
 * Must run after refresh/sync — do not use checkPaused() alone (it is true for both pause and cancel).
 */
export async function throwIfJobStopped(job, refresh, {
    cancelledMessage = 'Job cancelled',
    pausedMessage = 'Job paused'
} = {}) {
    if (typeof refresh === 'function') {
        await refresh();
    } else {
        applyJobControlFileToJob(job);
    }
    if (job?.cancelled) {
        throw createJobCancelledError(cancelledMessage);
    }
    if (job?.paused) {
        throw createJobPausedError(pausedMessage);
    }
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
