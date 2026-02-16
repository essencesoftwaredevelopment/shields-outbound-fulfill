import fs from 'fs';
import path from 'path';
import { TMP_ROOT } from '../config/paths.js';
import { firestore } from '../config/firebase.js';
import { DEFAULT_PRICING } from '../utils/pricing.js';
import { jobs, processJob } from '../services/jobPipeline.js';
import { ensureJobControl } from '../services/jobControl.js';
import { getQueueJob, setQueueStatus } from '../services/jobQueue.js';

function initialStageState() {
    return {
        status: 'pending',
        startedAt: null,
        completedAt: null,
        summary: null,
        error: null,
        progress: null
    };
}

function buildStages(rawStages = null) {
    const stageKeys = ['domainPrep', 'founders', 'emailDiscovery', 'verification', 'personalization'];
    const stages = {};
    for (const key of stageKeys) {
        stages[key] = {
            ...initialStageState(),
            ...(rawStages?.[key] || {})
        };
    }
    return stages;
}

async function loadApiKeys(uid) {
    const userDoc = await firestore.collection('users').doc(uid).get();
    if (!userDoc.exists) {
        throw new Error(`User document not found for uid ${uid}`);
    }
    const data = userDoc.data() || {};
    return {
        openai: data.openai_key || '',
        serper: data.serper_key || '',
        kitt: data.trykitt_key || ''
    };
}

function buildRuntimeJob(queueJob, apiKeys) {
    const payload = queueJob.payload || {};
    const jobId = queueJob.jobId;
    const jobDir = path.join(TMP_ROOT, jobId);
    const filteredPath = payload.filteredPath && fs.existsSync(payload.filteredPath)
        ? payload.filteredPath
        : path.join(jobDir, 'domains-filtered.csv');

    if (!fs.existsSync(path.join(jobDir, 'domains.csv'))) {
        throw new Error(`Input file missing for job ${jobId}`);
    }

    const control = ensureJobControl(jobId, {
        paused: !!queueJob?.control?.paused,
        cancelled: !!queueJob?.control?.cancelled
    });

    const job = {
        id: jobId,
        status: payload.status || 'queued',
        createdAt: payload.createdAt || new Date().toISOString(),
        completedAt: null,
        error: null,
        fileName: payload.fileName || 'domains.csv',
        apiKeys,
        uid: queueJob.uid,
        clientId: queueJob.clientId,
        sqlClientId: payload.sqlClientId || null,
        dedupeStrategy: payload.dedupeStrategy || 'skip',
        cancelled: !!control.cancelled,
        paused: !!control.paused,
        skipFounderFinder: !!payload.skipFounderFinder,
        skipEmailFinder: !!payload.skipEmailFinder,
        skipVerification: !!payload.skipVerification,
        findFounder: payload.findFounder !== false,
        industry: payload.industry || null,
        nicheId: payload.nicheId || null,
        nicheLabel: payload.nicheLabel || null,
        personalizeFirstLine: !!payload.personalizeFirstLine,
        emailVerificationProvider: payload.emailVerificationProvider || 'trykitt',
        columnMapping: payload.columnMapping || { domain: 'domain', founder: '', email: '' },
        pricing: DEFAULT_PRICING,
        cost: typeof payload.cost === 'number' ? payload.cost : 0,
        stages: buildStages(payload.stages),
        logs: [],
        streams: [],
        dedupeStats: payload.dedupeStats || null,
        __persistedOnce: true,
        paths: {
            dir: jobDir,
            tmpDir: jobDir,
            domains: path.join(jobDir, 'domains.csv'),
            filtered: fs.existsSync(filteredPath) ? filteredPath : null,
            founders: path.join(jobDir, 'founders.csv'),
            emails: path.join(jobDir, 'emails.csv'),
            final: path.join(jobDir, 'final.csv'),
            personalized: path.join(jobDir, 'personalized.csv'),
            upload: path.join(jobDir, 'upload.csv')
        }
    };

    return job;
}

async function main() {
    const jobId = process.argv[2];
    if (!jobId) {
        console.error('runJobChild requires a jobId argument');
        process.exit(1);
    }

    const queueJob = await getQueueJob(jobId);
    if (!queueJob) {
        console.error(`[${jobId}] Queue record not found`);
        process.exit(1);
    }

    if (queueJob.status === 'cancelled' || queueJob.control?.cancelled) {
        await setQueueStatus(jobId, 'cancelled', { error: 'Cancelled before execution' });
        process.exit(0);
    }

    let job = null;
    try {
        const apiKeys = await loadApiKeys(queueJob.uid);
        job = buildRuntimeJob(queueJob, apiKeys);
        jobs.set(job.id, job);

        await processJob(job);

        let finalStatus = 'failed';
        if (job.cancelled) {
            finalStatus = 'cancelled';
        } else if (job.paused) {
            finalStatus = 'paused';
        } else if (job.status === 'completed' || job.status === 'pending-upload') {
            finalStatus = 'completed';
        }

        await setQueueStatus(jobId, finalStatus, {
            error: job.error || null
        });

        process.exit(finalStatus === 'failed' ? 1 : 0);
    } catch (error) {
        console.error(`[${jobId}] Child job execution failed:`, error?.message || error);
        await setQueueStatus(jobId, 'failed', {
            error: error?.message || String(error)
        });
        process.exit(1);
    } finally {
        if (job?.id) {
            jobs.delete(job.id);
        }
    }
}

main();

