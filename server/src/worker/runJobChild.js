import { DEFAULT_PRICING } from '../utils/pricing.js';
import { jobs, processJob } from '../services/jobPipeline.js';
import { getQueueJob, setQueueStatus, clearRunnerPid } from '../services/jobQueue.js';
import { getJobById, inMemoryJobFromRow } from '../services/db/jobs.js';
import { getAgencySettings, apiKeysFromSettings } from '../services/db/agencySettings.js';

async function loadApiKeys(uid) {
    const settings = await getAgencySettings(uid);
    if (!settings) {
        throw new Error(`Agency settings not found for ${uid}`);
    }
    const keys = apiKeysFromSettings(settings);
    keys.kitt = settings.trykitt_key || '';
    return keys;
}

function buildRuntimeJob(queueJob, apiKeys, row) {
    const payload = queueJob.payload || {};
    const job = inMemoryJobFromRow(row, apiKeys);
    if (!job) throw new Error(`Failed to hydrate job ${queueJob.jobId}`);

    job.status = payload.status || row.status || 'queued';
    job.pricing = DEFAULT_PRICING;
    job.paused = !!queueJob?.control?.paused || !!row.paused;
    job.cancelled = !!queueJob?.control?.cancelled || !!row.cancelled;
    job.dedupeStats = row.dedupe_stats || payload.dedupeStats || null;
    job.__persistedOnce = true;
    return job;
}

function installShutdownSignals(jobId) {
    let exiting = false;
    const exitNow = (signal) => {
        if (exiting) return;
        exiting = true;
        console.log(`[${jobId}] ${signal} received — child exiting`);
        process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.on('SIGINT', () => exitNow('SIGINT'));
    process.on('SIGTERM', () => exitNow('SIGTERM'));
}

async function main() {
    const jobId = process.argv[2];
    if (!jobId) {
        console.error('runJobChild requires a jobId argument');
        process.exit(1);
    }
    installShutdownSignals(jobId);
    console.log(`[${jobId}] Child process starting (pid ${process.pid})`);

    try {
        const queueJob = await getQueueJob(jobId);
        if (!queueJob) {
            throw new Error(`Queue job ${jobId} not found`);
        }

        const row = await getJobById(jobId, queueJob.uid);
        if (!row) {
            throw new Error(`SQL job ${jobId} not found`);
        }

        const apiKeys = await loadApiKeys(queueJob.uid);
        const job = buildRuntimeJob(queueJob, apiKeys, row);
        jobs.set(jobId, job);

        await setQueueStatus(jobId, 'running');
        await processJob(job);

        const terminalStatus = job.cancelled ? 'cancelled' : (job.paused ? 'paused' : 'completed');
        await setQueueStatus(jobId, terminalStatus);
        console.log(`[${jobId}] Child process finished with status ${job.status} (queue ${terminalStatus})`);
        process.exit(0);
    } catch (error) {
        console.error(`[${jobId}] Child process failed:`, error?.message || error);
        await setQueueStatus(jobId, 'failed', { error: error?.message || String(error) });
        process.exit(1);
    } finally {
        jobs.delete(jobId);
        await clearRunnerPid(jobId).catch(() => {});
    }
}

main();
