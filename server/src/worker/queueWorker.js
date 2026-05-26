import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import { claimNextQueuedJob, getQueueJob, setQueueStatus, setRunnerPid, clearRunnerPid } from '../services/jobQueue.js';
import { pool } from '../config/db.js';
import { reconcileStaleRunners } from '../services/jobRunner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_CWD = path.resolve(__dirname, '../..');

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const POLL_INTERVAL_MS = Math.max(parseInt(process.env.JOB_QUEUE_POLL_MS || '1500', 10), 250);

let shutdownRequested = false;
let shutdownPass = 0;
let shutdownEscalateTimer = null;
let writeFreezeLogged = false;
/** @type {Map<string, import('child_process').ChildProcess>} */
const activeChildren = new Map();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWriteFreezeEnabled() {
    return String(process.env.DB_WRITE_FREEZE || 'false').toLowerCase() === 'true';
}

function terminateActiveChildren(signal = 'SIGTERM') {
    for (const [jobId, child] of activeChildren.entries()) {
        if (child && !child.killed) {
            try {
                child.kill(signal);
            } catch (err) {
                console.warn(`[worker:${WORKER_ID}] Failed to ${signal} child for ${jobId}:`, err?.message || err);
            }
        }
    }
}

async function finishWorkerShutdown(exitCode = 0) {
    if (shutdownEscalateTimer) {
        clearTimeout(shutdownEscalateTimer);
        shutdownEscalateTimer = null;
    }
    terminateActiveChildren('SIGKILL');
    try {
        await pool.end();
    } catch {
        /* noop */
    }
    process.exit(exitCode);
}

function requestWorkerShutdown(force = false) {
    shutdownRequested = true;
    terminateActiveChildren(force ? 'SIGKILL' : 'SIGTERM');
    if (force) {
        void finishWorkerShutdown(130);
        return;
    }
    if (shutdownEscalateTimer) return;
    shutdownEscalateTimer = setTimeout(() => {
        console.warn(`[worker:${WORKER_ID}] Shutdown timeout — SIGKILL on child runners`);
        void finishWorkerShutdown(130);
    }, 2000);
    shutdownEscalateTimer.unref();
}

function runChild(jobId) {
    return new Promise((resolve) => {
        const childPath = path.join(__dirname, 'runJobChild.js');
        const child = fork(childPath, [jobId], {
            stdio: 'inherit',
            cwd: SERVER_CWD
        });

        activeChildren.set(jobId, child);

        void setRunnerPid(jobId, child.pid, WORKER_ID).catch((err) => {
            console.error(`[worker:${WORKER_ID}] Failed to record runner PID for ${jobId}:`, err?.message || err);
        });

        child.on('exit', (code) => {
            activeChildren.delete(jobId);
            void clearRunnerPid(jobId).catch(() => {});
            resolve(typeof code === 'number' ? code : 1);
        });

        child.on('error', () => {
            activeChildren.delete(jobId);
            void clearRunnerPid(jobId).catch(() => {});
            resolve(1);
        });
    });
}

async function processClaimedJob(claimed) {
    const jobId = claimed.jobId;
    console.log(`[worker:${WORKER_ID}] Processing queued job ${jobId}`);
    const exitCode = await runChild(jobId);
    console.log(`[worker:${WORKER_ID}] Child finished for job ${jobId} with exit code ${exitCode}`);

    if (exitCode === 0) {
        console.log(`[worker:${WORKER_ID}] Job ${jobId} completed successfully`);
        return;
    }

    const latest = await getQueueJob(jobId);
    if (!latest) return;
    console.warn(
        `[worker:${WORKER_ID}] Job ${jobId} child failed, latest queue status=${latest.status}, paused=${!!latest.control?.paused}, cancelled=${!!latest.control?.cancelled}`
    );
    if (latest.status === 'completed' || latest.status === 'paused' || latest.status === 'cancelled' || latest.status === 'failed') {
        return;
    }

    await setQueueStatus(jobId, 'failed', {
        error: `Child process exited with code ${exitCode}`
    });
}

async function workerLoop() {
    if (!process.env.PGPASSWORD) {
        console.warn(`[worker:${WORKER_ID}] Warning: PGPASSWORD is empty; database auth may fail`);
    }

    try {
        const reconciled = await reconcileStaleRunners();
        if (reconciled > 0) {
            console.log(`[worker:${WORKER_ID}] Reconciled ${reconciled} stale runner(s) on startup`);
        }
    } catch (err) {
        console.error(`[worker:${WORKER_ID}] Stale runner reconciliation failed:`, err?.message || err);
    }

    console.log(`[worker:${WORKER_ID}] Queue worker started (poll ${POLL_INTERVAL_MS}ms)`);
    while (!shutdownRequested) {
        try {
            if (isWriteFreezeEnabled()) {
                if (!writeFreezeLogged) {
                    console.warn(`[worker:${WORKER_ID}] DB_WRITE_FREEZE=true: skipping queue claims`);
                    writeFreezeLogged = true;
                }
                await sleep(POLL_INTERVAL_MS);
                continue;
            }
            writeFreezeLogged = false;

            const claimed = await claimNextQueuedJob(WORKER_ID);
            if (!claimed) {
                await sleep(POLL_INTERVAL_MS);
                continue;
            }

            await processClaimedJob(claimed);
        } catch (error) {
            console.error(`[worker:${WORKER_ID}] Worker loop error:`, error?.message || error);
            await sleep(POLL_INTERVAL_MS);
        }
    }
    console.log(`[worker:${WORKER_ID}] Worker shutting down`);
    if (shutdownRequested) {
        await finishWorkerShutdown(0);
    }
}

process.on('SIGINT', () => {
    shutdownPass += 1;
    requestWorkerShutdown(shutdownPass > 1);
});

process.on('SIGTERM', () => {
    shutdownPass += 1;
    requestWorkerShutdown(shutdownPass > 1);
});

workerLoop().catch((error) => {
    console.error(`[worker:${WORKER_ID}] Fatal worker error:`, error);
    process.exit(1);
});
