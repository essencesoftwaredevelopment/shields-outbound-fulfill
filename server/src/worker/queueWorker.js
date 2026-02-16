import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import { claimNextQueuedJob, getQueueJob, setQueueStatus } from '../services/jobQueue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const POLL_INTERVAL_MS = Math.max(parseInt(process.env.JOB_QUEUE_POLL_MS || '1500', 10), 250);

let shutdownRequested = false;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function runChild(jobId) {
    return new Promise((resolve) => {
        const childPath = path.join(__dirname, 'runJobChild.js');
        const child = fork(childPath, [jobId], {
            stdio: 'inherit'
        });

        child.on('exit', (code) => {
            resolve(typeof code === 'number' ? code : 1);
        });

        child.on('error', () => {
            resolve(1);
        });
    });
}

async function processClaimedJob(claimed) {
    const jobId = claimed.jobId;
    console.log(`[worker:${WORKER_ID}] Processing queued job ${jobId}`);
    const exitCode = await runChild(jobId);

    if (exitCode === 0) {
        return;
    }

    const latest = await getQueueJob(jobId);
    if (!latest) return;
    if (latest.status === 'completed' || latest.status === 'paused' || latest.status === 'cancelled' || latest.status === 'failed') {
        return;
    }

    await setQueueStatus(jobId, 'failed', {
        error: `Child process exited with code ${exitCode}`
    });
}

async function workerLoop() {
    console.log(`[worker:${WORKER_ID}] Queue worker started (poll ${POLL_INTERVAL_MS}ms)`);
    while (!shutdownRequested) {
        try {
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
}

process.on('SIGINT', () => {
    shutdownRequested = true;
});

process.on('SIGTERM', () => {
    shutdownRequested = true;
});

workerLoop().catch((error) => {
    console.error(`[worker:${WORKER_ID}] Fatal worker error:`, error);
    process.exit(1);
});

