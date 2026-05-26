/**
 * Queue runner PID tracking and force-terminate helpers.
 */
import { pool } from '../config/db.js';
import { clearRunnerPid, getRunnerRecord, setQueueStatus } from './jobQueue.js';

export const STOP_COOPERATIVE_MS = 8000;
export const STOP_SIGKILL_DELAY_MS = 3000;
/** Fast path for API/worker shutdown (no 8s cooperative wait). */
export const SHUTDOWN_RUNNER_OPTS = { cooperativeMs: 0, killDelayMs: 500 };

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPidAlive(pid) {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        if (err?.code === 'ESRCH') return false;
        if (err?.code === 'EPERM') return true;
        return false;
    }
}

export async function signalRunnerPid(pid, signal) {
    if (!isPidAlive(pid)) return false;
    try {
        process.kill(pid, signal);
        return true;
    } catch (err) {
        if (err?.code === 'ESRCH') return false;
        throw err;
    }
}

/**
 * Hybrid stop: wait for cooperative exit, then SIGTERM, then SIGKILL.
 */
export async function forceTerminateRunner(jobId, { cooperativeMs = STOP_COOPERATIVE_MS, killDelayMs = STOP_SIGKILL_DELAY_MS } = {}) {
    const record = await getRunnerRecord(jobId);
    const pid = record?.runner_pid;
    if (!pid) return { terminated: false, reason: 'no_pid' };

    const deadline = Date.now() + cooperativeMs;
    while (Date.now() < deadline) {
        if (!isPidAlive(pid)) {
            await clearRunnerPid(jobId);
            return { terminated: true, reason: 'exited_cooperative' };
        }
        await sleep(250);
    }

    if (!isPidAlive(pid)) {
        await clearRunnerPid(jobId);
        return { terminated: true, reason: 'exited_before_sigterm' };
    }

    await signalRunnerPid(pid, 'SIGTERM');
    const killDeadline = Date.now() + killDelayMs;
    while (Date.now() < killDeadline) {
        if (!isPidAlive(pid)) {
            await clearRunnerPid(jobId);
            return { terminated: true, reason: 'exited_after_sigterm' };
        }
        await sleep(200);
    }

    if (isPidAlive(pid)) {
        await signalRunnerPid(pid, 'SIGKILL');
        await sleep(200);
    }

    if (!isPidAlive(pid)) {
        await clearRunnerPid(jobId);
        return { terminated: true, reason: 'sigkill' };
    }

    return { terminated: false, reason: 'still_alive', pid };
}

/**
 * On worker boot: reconcile stale running rows and orphan PIDs (Q4 B).
 */
export async function reconcileStaleRunners() {
    const result = await pool.query(
        `SELECT jq.job_id, jq.runner_pid, jq.status, jq.control,
                j.paused, j.cancelled, j.status AS job_status
         FROM job_queue jq
         JOIN jobs j ON j.id = jq.job_id
         WHERE jq.status = 'running'
            OR (jq.runner_pid IS NOT NULL AND jq.status NOT IN ('completed', 'cancelled', 'failed'))`
    );

    let reconciled = 0;
    for (const row of result.rows) {
        const jobId = row.job_id;
        const pid = row.runner_pid;
        const cancelled = !!row.cancelled || !!row.control?.cancelled;

        if (pid && isPidAlive(pid)) {
            console.log(`[reconcile] Terminating orphan runner pid=${pid} for job ${jobId}`);
            await signalRunnerPid(pid, 'SIGTERM');
            await sleep(STOP_SIGKILL_DELAY_MS);
            if (isPidAlive(pid)) {
                await signalRunnerPid(pid, 'SIGKILL');
            }
            reconciled += 1;
        }

        await clearRunnerPid(jobId);

        if (cancelled) {
            await setQueueStatus(jobId, 'cancelled', { error: row.control?.error || 'Cancelled' });
        } else if (row.paused || row.control?.paused) {
            await setQueueStatus(jobId, 'paused');
        } else if (row.job_status !== 'completed' && row.job_status !== 'cancelled') {
            await setQueueStatus(jobId, 'queued', { error: null });
            console.log(`[reconcile] Re-queued job ${jobId} after stale runner cleanup`);
        }
    }

    return reconciled;
}

/**
 * API shutdown: terminate all jobs with a live runner PID.
 */
export async function terminateAllRunningRunners(opts = SHUTDOWN_RUNNER_OPTS) {
    const result = await pool.query(
        `SELECT job_id, runner_pid FROM job_queue
         WHERE runner_pid IS NOT NULL AND status = 'running'`
    );
    for (const row of result.rows) {
        if (!row.runner_pid) continue;
        try {
            await forceTerminateRunner(row.job_id, opts);
        } catch (err) {
            console.error(`[shutdown] Failed to terminate job ${row.job_id}:`, err?.message || err);
        }
    }
}
