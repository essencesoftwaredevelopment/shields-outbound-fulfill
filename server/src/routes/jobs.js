/**
 * Jobs API endpoints (Pipeline orchestration)
 *
 * CANONICAL AGENCY IDENTIFIER RULE:
 * The Firestore users/{uid} document ID is the canonical agency identifier.
 * This same Firebase Auth uid is used directly as agency_id in all Cloud SQL tables.
 * No reconciliation or mapping is required.
 *
 * This route manages:
 * 1. Firestore orchestration (job state, status, client metadata)
 * 2. CSV file uploads and processing
 * 3. Integration with Cloud SQL via the leads service (see services/leads.js)
 *
 * All Cloud SQL operations are scoped by agency_id derived from the verified Firebase token.
 */

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { admin, firestore } from '../config/firebase.js';
import { buildUnifiedRows } from '../utils/csv.js';
import { attachCampaignToLeads, filterAndWriteProcessedDomains, incrementCampaignLeadCount } from '../services/leads.js';
import { createJobRecord, processJob, jobs, logJob, markCancelled, markPaused, markResumed, resolveJobPaths, serializeJob, closeStreams } from '../services/jobPipeline.js';
import { getOrCreateClient } from '../services/db/queries.js';
import { pool } from '../config/db.js';
import { runPersonalizerPipeline } from '../services/personalizerPipeline.js';
import path from 'path';
import { TMP_ROOT } from '../config/paths.js';
import { ensureJobControl, writeJobControl } from '../services/jobControl.js';
import { deleteQueueJob, enqueuePipelineJob, getQueueJob, setQueueStatus, updateQueueControl } from '../services/jobQueue.js';

const router = express.Router();
const JOB_EXECUTION_MODE = String(process.env.JOB_EXECUTION_MODE || 'inline').toLowerCase();
const USE_QUEUE_EXECUTION = JOB_EXECUTION_MODE === 'queue';

function buildQueuePayload(job) {
    return {
        id: job.id,
        fileName: job.fileName,
        createdAt: job.createdAt,
        dedupeStrategy: job.dedupeStrategy,
        sqlClientId: job.sqlClientId,
        skipFounderFinder: !!job.skipFounderFinder,
        skipEmailFinder: !!job.skipEmailFinder,
        skipVerification: !!job.skipVerification,
        skipDomainCheck: !!job.skipDomainCheck,
        findFounder: job.findFounder !== false,
        industry: job.industry || null,
        nicheId: job.nicheId || null,
        nicheLabel: job.nicheLabel || null,
        personalizeFirstLine: !!job.personalizeFirstLine,
        emailVerificationProvider: job.emailVerificationProvider || 'trykitt',
        columnMapping: job.columnMapping || { domain: 'domain', founder: '', email: '' },
        dedupeStats: job.dedupeStats || null,
        cost: typeof job.cost === 'number' ? job.cost : 0,
        stages: job.stages || null,
        filteredPath: job.paths?.filtered || null
    };
}

async function verifyQueuedJobOwnership({ jobId, uid, clientId }) {
    const queueJob = await getQueueJob(jobId);
    if (!queueJob) return { queueJob: null, error: 'Job not found.' };
    if (queueJob.uid !== uid || queueJob.clientId !== clientId) {
        return { queueJob: null, error: 'Unauthorized.' };
    }
    return { queueJob, error: null };
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const uploadFields = upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'idToken', maxCount: 1 },
    { name: 'clientId', maxCount: 1 },
    { name: 'nicheId', maxCount: 1 },
    { name: 'nicheLabel', maxCount: 1 },
    { name: 'skipFounderFinder', maxCount: 1 },
    { name: 'skipEmailFinder', maxCount: 1 },
    { name: 'skipVerification', maxCount: 1 },
    { name: 'skipDomainCheck', maxCount: 1 },
    { name: 'industry', maxCount: 1 },
    { name: 'personalizeFirstLine', maxCount: 1 },
    { name: 'domainColumn', maxCount: 1 },
    { name: 'founderColumn', maxCount: 1 },
    { name: 'emailColumn', maxCount: 1 }
]);

// Get CSV preview for column mapping
router.post('/jobs/:id/csv-preview', async (req, res) => {
    try {
        const { idToken, clientId } = req.body || {};
        const jobId = req.params.id;

        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });

        await admin.auth().verifyIdToken(idToken);

        const unified = await buildUnifiedRows({ jobId, scope: 'valid', resolveJobPaths });
        if (!unified.length) {
            return res.status(404).json({ error: 'No verified leads available for upload.' });
        }

        const allKeys = new Set();
        unified.forEach((row) => Object.keys(row).forEach((k) => allKeys.add(k)));
        const headers = Array.from(allKeys);
        const previewRows = unified.slice(0, 100);

        res.json({ headers, previewRows });
    } catch (error) {
        console.error('CSV preview error:', error);
        res.status(500).json({ error: 'Failed to load CSV preview.' });
    }
});

router.post('/jobs', uploadFields, async (req, res) => {
    try {
        if (!req.files?.file || !req.files.file[0]) {
            return res.status(400).json({ error: 'Missing CSV file upload.' });
        }

        const idToken = req.body.idToken;
        if (!idToken) {
            return res.status(400).json({ error: 'Missing ID token.' });
        }

        // Verify the ID token
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const uid = decodedToken.uid;

        // Fetch API keys from Firestore
        const userDoc = await firestore.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.status(400).json({ error: 'User not found.' });
        }
        const userData = userDoc.data();
        const apiKeys = {
            openai: userData?.openai_key || '',
            serper: userData?.serper_key || '',
            kitt: userData?.trykitt_key || ''
        };

        // Get email verification provider preference (default to trykitt)
        const emailVerificationProvider = userData?.email_verification_provider || 'trykitt';

        if (!apiKeys.openai || !apiKeys.serper) {
            return res.status(400).json({ error: 'Missing required API keys (OpenAI, Serper) in user vault.' });
        }

        // Only require Kitt key if using trykitt provider
        if (emailVerificationProvider === 'trykitt' && !apiKeys.kitt) {
            return res.status(400).json({ error: 'Missing Kitt API key for TryKitt provider.' });
        }

        const file = req.files.file[0];
        const clientSlug = (req.body.clientId || '').toString().trim();
        
        // Resolve client slug to numeric ID for SQL operations (get or create client)
        let sqlClientId;
        try {
            sqlClientId = await getOrCreateClient(uid, clientSlug);
        } catch (error) {
            console.error('Failed to resolve client ID:', error);
            return res.status(500).json({ error: 'Failed to resolve client ID.' });
        }
        
        const dedupeStrategy = (req.body.dedupeStrategy || 'skip').toString(); // 'skip' | 'include'
        const rawSkipFounder = String(req.body.skipFounderFinder || '').toLowerCase() === 'true';
        const rawFindFounder = String(req.body.findFounder ?? 'true').toLowerCase() !== 'false';
        const skipFounderFinder = rawSkipFounder || !rawFindFounder;
        const industry = (req.body.industry || req.body.nicheId || '').toString().trim();
        const nicheId = (req.body.nicheId || '').toString().trim();
        const nicheLabel = (req.body.nicheLabel || '').toString().trim();
        const personalizeFirstLine = String(req.body.personalizeFirstLine || '').toLowerCase() === 'true';
        let skipVerification = String(req.body.skipVerification || '').toLowerCase() === 'true';
        
        // Auto-skip verification when using self-hosted email finding (emails are already verified)
        if (emailVerificationProvider === 'self_hosted') {
            skipVerification = true;
        }
        
        const skipEmailFinder = String(req.body.skipEmailFinder || '').toLowerCase() === 'true';
        const skipDomainCheck = String(req.body.skipDomainCheck || '').toLowerCase() === 'true';
        const domainColumn = (req.body.domainColumn || 'domain').toString().trim();
        const founderColumn = (req.body.founderColumn || '').toString().trim();
        const emailColumn = (req.body.emailColumn || '').toString().trim();
        const job = createJobRecord(file.buffer, file.originalname, apiKeys, uid, clientSlug, dedupeStrategy, {
            skipFounderFinder,
            skipEmailFinder,
            skipVerification,
            skipDomainCheck,
            findFounder: rawFindFounder,
            industry,
            nicheId,
            nicheLabel,
            personalizeFirstLine,
            emailVerificationProvider,
            sqlClientId,
            columnMapping: {
                domain: domainColumn,
                founder: founderColumn,
                email: emailColumn
            }
        });
        logJob(job, `Job ${USE_QUEUE_EXECUTION ? 'queued' : 'started inline'} with file ${job.fileName} for user ${uid}`);

        // Calculate dedupe stats synchronously before responding
        try {
            const { filtered: filteredDomainsPath, stats: dedupeStats } = await filterAndWriteProcessedDomains({
                agencyId: job.uid,
                clientId: job.sqlClientId,
                jobId: job.id,
                domainsCsvPath: job.paths.domains,
                dedupeStrategy: job.dedupeStrategy,
                domainColumn: domainColumn
            });
            job.dedupeStats = dedupeStats;
            job.paths.filtered = filteredDomainsPath; // Store filtered path for processJob to use
            logJob(job, `Deduplication complete: ${dedupeStats.total} total, ${dedupeStats.skipped} skipped, ${dedupeStats.new} new`);
        } catch (err) {
            console.error('Deduplication error:', err);
            // Continue with job processing even if deduplication fails
        }

        if (USE_QUEUE_EXECUTION) {
            await enqueuePipelineJob({
                jobId: job.id,
                uid,
                clientId: job.clientId,
                payload: buildQueuePayload(job)
            });
        }

        await firestore
            .collection('users').doc(uid)
            .collection('clients').doc(job.clientId)
            .collection('jobs').doc(job.id)
            .set({
                ...serializeJob(job),
                logs: Array.isArray(job.logs) ? job.logs.slice(-200) : [],
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                createdAtServer: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

        await firestore
            .collection('users').doc(uid)
            .collection('clients').doc(job.clientId)
            .collection('activeJob').doc('current')
            .set({
                jobId: job.id,
                status: USE_QUEUE_EXECUTION ? 'queued' : 'running',
                error: null,
                uploadError: null,
                uploadMetrics: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

        ensureJobControl(job.id, { paused: false, cancelled: false });

        if (USE_QUEUE_EXECUTION) {
            closeStreams(job);
            jobs.delete(job.id);
        } else {
            setImmediate(() => {
                processJob(job)
                    .catch((err) => {
                        console.error(`[${job.id}] Inline job execution failed:`, err?.message || err);
                    })
                    .finally(() => {
                        closeStreams(job);
                        jobs.delete(job.id);
                    });
            });
        }

        res.status(201).json({ jobId: job.id, job: serializeJob(job) });
    } catch (error) {
        console.error('Job creation error:', error);
        res.status(500).json({ error: 'Failed to create job.' });
    }
});

router.get('/jobs/:id', async (req, res) => {
    const jobId = req.params.id;
    
    // First check in-memory jobs (active/running jobs)
    const job = jobs.get(jobId);
    if (job) {
        return res.json({ job: serializeJob(job) });
    }
    
    // If not in memory, try to fetch from Firestore (completed jobs)
    try {
        const idToken = req.headers.authorization?.replace('Bearer ', '');
        if (!idToken) {
            return res.status(404).json({ error: 'Job not found in memory and no auth token provided' });
        }
        
        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;
        const clientId = req.query.clientId;
        
        if (!clientId) {
            return res.status(404).json({ error: 'Job not found in memory and no clientId provided' });
        }
        
        const jobRef = firestore
            .collection('users').doc(uid)
            .collection('clients').doc(clientId)
            .collection('jobs').doc(jobId);
        
        const snapshot = await jobRef.get();
        if (!snapshot.exists) {
            return res.status(404).json({ error: 'Job not found' });
        }
        
        return res.json({ job: snapshot.data() });
    } catch (error) {
        console.error(`Failed to fetch job ${jobId} from Firestore:`, error);
        return res.status(404).json({ error: 'Job not found' });
    }
});

// Stop a running job
router.post('/jobs/:id/stop', async (req, res) => {
    try {
        const jobId = req.params.id;
        const { idToken, clientId } = req.body || {};
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const localJob = jobs.get(jobId);
        if (localJob && (localJob.uid !== uid || localJob.clientId !== clientId)) {
            return res.status(403).json({ error: 'Unauthorized to stop this job.' });
        }

        let queueJob = null;
        if (!localJob) {
            const ownership = await verifyQueuedJobOwnership({ jobId, uid, clientId });
            if (ownership.error) {
                if (ownership.error === 'Unauthorized.') return res.status(403).json({ error: 'Unauthorized to stop this job.' });
                return res.status(404).json({ error: 'Job not found.' });
            }
            queueJob = ownership.queueJob;
        } else {
            queueJob = await getQueueJob(jobId);
        }

        if (queueJob?.status === 'completed') {
            return res.json({ status: 'completed', message: 'Job already completed.' });
        }
        if (queueJob?.status === 'cancelled') {
            return res.json({ status: 'cancelled', message: 'Job already cancelled.' });
        }

        writeJobControl(jobId, { cancelled: true, paused: false });
        if (queueJob) {
            await updateQueueControl(jobId, { cancelled: true, paused: false });
        }
        if (queueJob?.status === 'queued' || queueJob?.status === 'paused') {
            await setQueueStatus(jobId, 'cancelled', { error: 'Cancelled by user' });
        }

        if (localJob && localJob.uid === uid && localJob.clientId === clientId) {
            localJob.cancelled = true;
            markCancelled(localJob, 'Cancelled by user');
        }

        // Update activeJob doc to reflect cancellation
        try {
            const activeJobRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId).collection('activeJob').doc('current');
            await activeJobRef.set({
                jobId,
                status: 'cancelled',
                uploadError: null,
                uploadMetrics: null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (err) {
            console.warn('Failed to persist cancelled status to Firestore', err?.message || err);
        }

        return res.json({ status: 'cancelled' });
    } catch (error) {
        console.error('Stop job error:', error);
        return res.status(500).json({ error: 'Failed to cancel job.' });
    }
});

// Pause a running job
router.post('/jobs/:id/pause', async (req, res) => {
    try {
        const jobId = req.params.id;
        const { idToken, clientId } = req.body || {};
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const localJob = jobs.get(jobId);
        if (localJob && (localJob.uid !== uid || localJob.clientId !== clientId)) {
            return res.status(403).json({ error: 'Unauthorized to pause this job.' });
        }

        let queueJob = null;
        if (!localJob) {
            const ownership = await verifyQueuedJobOwnership({ jobId, uid, clientId });
            if (ownership.error) {
                if (ownership.error === 'Unauthorized.') return res.status(403).json({ error: 'Unauthorized to pause this job.' });
                return res.status(404).json({ error: 'Job not found.' });
            }
            queueJob = ownership.queueJob;
        } else {
            queueJob = await getQueueJob(jobId);
        }

        if (queueJob?.status === 'cancelled') {
            return res.json({ status: 'cancelled', message: 'Job is cancelled, cannot pause.' });
        }
        if (queueJob?.status === 'paused' || queueJob?.control?.paused || localJob?.paused) {
            return res.json({ status: 'paused', message: 'Job already paused.' });
        }

        writeJobControl(jobId, { paused: true });
        if (queueJob) {
            await updateQueueControl(jobId, { paused: true });
        }
        if (queueJob?.status === 'queued') {
            await setQueueStatus(jobId, 'paused');
        }

        if (localJob && localJob.uid === uid && localJob.clientId === clientId) {
            markPaused(localJob, 'Paused by user');
        }

        // Update activeJob doc
        try {
            const activeJobRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId).collection('activeJob').doc('current');
            await activeJobRef.set({
                jobId,
                status: 'paused',
                pausedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (err) {
            console.warn('Failed to persist paused status to Firestore', err?.message || err);
        }

        return res.json({ status: 'paused' });
    } catch (error) {
        console.error('Pause job error:', error);
        return res.status(500).json({ error: 'Failed to pause job.' });
    }
});

// Resume a paused job
router.post('/jobs/:id/resume', async (req, res) => {
    try {
        const jobId = req.params.id;
        const { idToken, clientId } = req.body || {};
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const localJob = jobs.get(jobId);
        if (localJob && (localJob.uid !== uid || localJob.clientId !== clientId)) {
            return res.status(403).json({ error: 'Unauthorized to resume this job.' });
        }

        let queueJob = null;
        if (!localJob) {
            const ownership = await verifyQueuedJobOwnership({ jobId, uid, clientId });
            if (ownership.error) {
                if (ownership.error === 'Unauthorized.') return res.status(403).json({ error: 'Unauthorized to resume this job.' });
                return res.status(404).json({ error: 'Job not found.' });
            }
            queueJob = ownership.queueJob;
        } else {
            queueJob = await getQueueJob(jobId);
        }

        if (queueJob?.status === 'cancelled') {
            return res.json({ status: 'cancelled', message: 'Job is cancelled, cannot resume.' });
        }
        if (queueJob && queueJob.status !== 'paused' && !queueJob.control?.paused && !localJob?.paused) {
            return res.json({ status: queueJob.status, message: 'Job is not paused.' });
        }
        if (!queueJob && !localJob?.paused) {
            return res.json({ status: localJob?.status || 'unknown', message: 'Job is not paused.' });
        }

        writeJobControl(jobId, { paused: false });
        if (queueJob) {
            await updateQueueControl(jobId, { paused: false });
        }
        if (queueJob?.status === 'paused') {
            await setQueueStatus(jobId, 'queued', { error: null });
        }

        if (localJob && localJob.uid === uid && localJob.clientId === clientId) {
            markResumed(localJob);
        }

        const resumedStatus = queueJob?.status === 'running'
            ? 'running'
            : (localJob ? 'running' : 'queued');

        // Update activeJob doc
        try {
            const activeJobRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId).collection('activeJob').doc('current');
            await activeJobRef.set({
                jobId,
                status: resumedStatus,
                resumedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (err) {
            console.warn('Failed to persist resumed status to Firestore', err?.message || err);
        }

        return res.json({ status: resumedStatus });
    } catch (error) {
        console.error('Resume job error:', error);
        return res.status(500).json({ error: 'Failed to resume job.' });
    }
});

// Delete a job (remove files, memory state, and Firestore record)
router.post('/jobs/:id/delete', async (req, res) => {
    try {
        const jobId = req.params.id;
        const { idToken, clientId } = req.body || {};
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const job = jobs.get(jobId);
        const queueJob = await getQueueJob(jobId);
        if (queueJob && (queueJob.uid !== uid || queueJob.clientId !== clientId)) {
            return res.status(403).json({ error: 'Unauthorized to delete this job.' });
        }
        if (job && (job.uid !== uid || job.clientId !== clientId)) {
            return res.status(403).json({ error: 'Unauthorized to delete this job.' });
        }

        if (job) {
            if (!job.cancelled && job.status === 'running') {
                markCancelled(job, 'Deleted by user');
            }
            closeStreams(job);
            jobs.delete(jobId);
        }

        try {
            const { jobDir } = resolveJobPaths(jobId);
            if (jobDir && fs.existsSync(jobDir)) {
                fs.rmSync(jobDir, { recursive: true, force: true });
            }
        } catch (err) {
            console.warn(`[${jobId}] Failed to clean job files`, err?.message || err);
        }

        try {
            await deleteQueueJob(jobId);
        } catch (err) {
            console.warn(`[${jobId}] Failed to delete queue record`, err?.message || err);
        }

        try {
            const jobRef = firestore
                .collection('users').doc(uid)
                .collection('clients').doc(clientId)
                .collection('jobs').doc(jobId);
            await jobRef.delete();

            const activeRef = firestore
                .collection('users').doc(uid)
                .collection('clients').doc(clientId)
                .collection('activeJob').doc('current');
            const activeSnap = await activeRef.get();
            const isCurrent = activeSnap.exists && (activeSnap.data()?.jobId === jobId);
            if (isCurrent) {
                await activeRef.set({
                    status: 'deleted',
                    jobId: null,
                    uploadError: null,
                    uploadMetrics: null,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            }
        } catch (err) {
            console.warn(`[${jobId}] Failed to delete Firestore job record`, err?.message || err);
        }

        return res.json({ status: 'deleted' });
    } catch (error) {
        console.error('Delete job error:', error);
        return res.status(500).json({ error: 'Failed to delete job.' });
    }
});

router.get('/jobs/:id/result', async (req, res) => {
    const jobId = req.params.id;
    const scopeParam = (req.query?.scope || '').toString() === 'valid' ? 'valid' : 'all';
    const { job, finalPath } = resolveJobPaths(jobId);

    if (!fs.existsSync(finalPath)) {
        return res.status(404).json({ error: 'Result file missing' });
    }
    if (job && job.status !== 'completed' && job.status !== 'pending-upload') {
        return res.status(409).json({ error: 'Job not completed yet' });
    }

    try {
        const rows = await buildUnifiedRows({ jobId, scope: scopeParam, resolveJobPaths });
        if (!rows.length) {
            return res.status(404).json({ error: 'No data to export.' });
        }
        const headers = Array.from(new Set(rows.flatMap(r => Object.keys(r))));
        const csvLines = [headers.join(',')];
        rows.forEach((row) => {
            const line = headers.map((key) => {
                const safe = String(row[key] ?? '').replace(/"/g, '""');
                return `"${safe}"`;
            }).join(',');
            csvLines.push(line);
        });
        const filename = `results-${jobId}-${scopeParam}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=\"${filename}\"`);
        res.send(csvLines.join('\n'));
    } catch (error) {
        console.error('Result download error:', error);
        res.status(500).json({ error: 'Failed to build export.' });
    }
});

router.get('/jobs/:id/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const job = jobs.get(req.params.id);
    if (!job) {
        (async () => {
            const jobId = req.params.id;
            let queueJob = await getQueueJob(jobId);
            if (!queueJob?.uid || !queueJob?.clientId) {
                const cg = await firestore.collectionGroup('jobs')
                    .where('id', '==', jobId)
                    .limit(1)
                    .get();
                if (!cg.empty) {
                    const [jobDoc] = cg.docs;
                    const parent = jobDoc.ref.parent?.parent; // clients/{clientId}
                    const userRef = parent?.parent?.parent?.parent; // users/{uid}
                    if (parent?.id && userRef?.id) {
                        queueJob = { uid: userRef.id, clientId: parent.id };
                    }
                }
            }

            if (!queueJob?.uid || !queueJob?.clientId) {
                res.write(`data: ${JSON.stringify({ type: 'error', error: 'Job not found' })}\n\n`);
                return res.end();
            }

            const jobRef = firestore
                .collection('users').doc(queueJob.uid)
                .collection('clients').doc(queueJob.clientId)
                .collection('jobs').doc(jobId);

            let sentLogCount = 0;
            const unsubscribe = jobRef.onSnapshot(
                (snap) => {
                    if (!snap.exists) {
                        res.write(`data: ${JSON.stringify({ type: 'error', error: 'Job not found' })}\n\n`);
                        return;
                    }

                    const state = snap.data() || {};
                    const logs = Array.isArray(state.logs) ? state.logs : [];
                    if (logs.length > sentLogCount) {
                        for (let i = sentLogCount; i < logs.length; i += 1) {
                            res.write(`data: ${JSON.stringify({ type: 'log', log: logs[i] })}\n\n`);
                        }
                        sentLogCount = logs.length;
                    }

                    res.write(`data: ${JSON.stringify({ type: 'state', state })}\n\n`);
                },
                (error) => {
                    console.error(`[${jobId}] Firestore stream error:`, error?.message || error);
                    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Stream disconnected' })}\n\n`);
                }
            );

            const keepAlive = setInterval(() => {
                res.write(': keep-alive\n\n');
            }, 25000);

            req.on('close', () => {
                clearInterval(keepAlive);
                unsubscribe();
                res.end();
            });
        })().catch((error) => {
            console.error('Job stream setup error:', error);
            res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to open job stream' })}\n\n`);
            res.end();
        });
        return;
    }

    job.logs.forEach(entry => {
        res.write(`data: ${JSON.stringify({ type: 'log', log: entry })}\n\n`);
    });
    res.write(`data: ${JSON.stringify({ type: 'state', state: serializeJob(job) })}\n\n`);

    job.streams.push(res);

    const keepAlive = setInterval(() => {
        res.write(': keep-alive\n\n');
    }, 25000);

    req.on('close', () => {
        clearInterval(keepAlive);
        job.streams = job.streams.filter(stream => stream !== res);
        res.end();
    });
});

router.post('/jobs/:id/upload-to-instantly', async (req, res) => {
    const jobId = req.params.id;
    let activeJobRef = null;
    let jobDocRef = null;
    let campaignIdParam = null;

    const recordUploadStatus = async (count, total) => {
        if (!activeJobRef) {
            return;
        }
        try {
            const updates = [
                activeJobRef.set({
                    jobId,
                    status: 'uploaded',
                    uploadMetrics: { count, total },
                    uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                    campaignId: campaignIdParam || null,
                    uploadError: admin.firestore.FieldValue.delete ? admin.firestore.FieldValue.delete() : null,
                }, { merge: true })
            ];

            if (jobDocRef) {
                updates.push(
                    jobDocRef.set({
                        instantlyUpload: {
                            count,
                            total,
                            campaignId: campaignIdParam || null,
                            uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                        },
                    }, { merge: true })
                );
            }

            await Promise.all(updates);
        } catch (firestoreError) {
            console.error('Failed to record Instantly upload status:', firestoreError);
        }
    };

    const recordUploadFailure = async (message) => {
        if (!activeJobRef) {
            return;
        }
        try {
            await activeJobRef.set({
                jobId,
                status: 'pending-upload',
                uploadError: message,
                lastUploadErrorAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
        } catch (firestoreError) {
            console.error('Failed to persist Instantly upload error state:', firestoreError);
        }
    };

    try {
        const { idToken, clientId, campaignId, columnMapping, customVariables, skipOptions } = req.body || {};
        campaignIdParam = campaignId;

        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!campaignId) return res.status(400).json({ error: 'Missing campaign ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });
        if (!columnMapping) return res.status(400).json({ error: 'Missing column mapping.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        // Get client's Instantly API key
        const clientRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId);
        const clientSnap = await clientRef.get();
        if (!clientSnap.exists) {
            return res.status(404).json({ error: 'Client not found' });
        }
        const instantlyKey = clientSnap.data()?.instantly_key || '';
        if (!instantlyKey) {
            return res.status(400).json({ error: 'Client has no Instantly API key configured' });
        }

        activeJobRef = clientRef.collection('activeJob').doc('current');
        jobDocRef = clientRef.collection('jobs').doc(jobId);

        const verified = await buildUnifiedRows({ jobId, scope: 'valid', resolveJobPaths });

        if (verified.length === 0) {
            await recordUploadStatus(0, 0);
            return res.json({ count: 0, total: 0, message: 'No verified emails to upload' });
        }

        // Upload to Instantly in batches
        const batchSize = 100;
        let uploaded = 0;

        const customVarsArray = Array.isArray(customVariables) ? customVariables : [];

        const skipPayload = {
            skip_if_in_workspace: !!skipOptions?.skip_if_in_workspace,
            skip_if_in_campaign: !!skipOptions?.skip_if_in_campaign,
            skip_if_in_list: !!skipOptions?.skip_if_in_list
        };

        for (let i = 0; i < verified.length; i += batchSize) {
            const batch = verified.slice(i, i + batchSize);
            const leads = batch.map(row => {
                const lead = {};

                // Map standard Instantly fields
                Object.entries(columnMapping).forEach(([field, mapping]) => {
                    if (!mapping.column) return;

                    const value = row[mapping.column] || '';

                    if (field === 'email') {
                        lead.email = value;
                    } else if (field === 'firstName') {
                        lead.first_name = value;
                    } else if (field === 'lastName') {
                        lead.last_name = value;
                    } else if (field === 'companyName') {
                        lead.company_name = value;
                    } else if (field === 'website') {
                        lead.website = value;
                    } else if (field === 'personalization') {
                        lead.personalization = value;
                    } else if (field.startsWith('custom_')) {
                        // Custom variables
                        const customFieldName = field.replace('custom_', '');
                        lead[customFieldName] = value;
                    }
                });
                // Defaults
                if (!lead.website) {
                    lead.website = row.domain || '';
                }

                // Custom variables (exact user-provided keys)
                if (customVarsArray.length > 0) {
                    const cvPayload = {};
                    customVarsArray.forEach((cv) => {
                        if (!cv?.name || !cv?.column) return;
                        const val = row[cv.column] || '';
                        cvPayload[cv.name] = val;
                    });
                    if (Object.keys(cvPayload).length > 0) {
                        lead.custom_variables = cvPayload;
                    }
                }

                return lead;
            });

            // Debug: Log first lead in batch to verify personalization
            if (leads.length > 0) {
                console.log(`[Batch ${i / batchSize + 1}] Sample lead:`, JSON.stringify(leads[0], null, 2));
            }

            try {
                // Instantly v2 with Bearer auth only
                const response = await fetch('https://api.instantly.ai/api/v2/leads/add', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${instantlyKey}`
                    },
                    body: JSON.stringify({
                        campaign_id: campaignId,
                        leads,
                        ...skipPayload
                    })
                });

                if (!response.ok) {
                    const status = response.status;
                    const errorText = await response.text().catch(() => '');
                    console.error(`Instantly v2 upload failed for batch ${i / batchSize + 1}: (${status}) ${errorText}`);
                    if (status === 401) {
                        await recordUploadFailure('Instantly v2 authentication failed. Check API key and permissions.');
                        return res.status(401).json({ error: 'ERR_AUTH_FAILED', message: 'Instantly v2 authentication failed. Check API key and permissions.' });
                    }
                    throw new Error(`Instantly v2 API error: ${status}`);
                }

                // Successfully uploaded this batch
                uploaded += leads.length;
                console.log(`Successfully uploaded batch ${i / batchSize + 1}: ${leads.length} leads (total: ${uploaded}/${verified.length})`);
            } catch (error) {
                console.error('Error uploading batch to Instantly v2:', error);
                // Continue with other batches on non-auth errors
            }
        }

        await recordUploadStatus(uploaded, verified.length);
        // Persist campaign association and counts in Firestore
        try {
            if (uploaded > 0) {
                await attachCampaignToLeads({ clientId, rows: verified.slice(0, uploaded) });
                await incrementCampaignLeadCount({ clientId, campaignId, delta: uploaded });
            }
        } catch (firestoreError) {
            console.warn('Failed to persist campaign lead linkage/counts:', firestoreError?.message || firestoreError);
        }
        
        // Track upload in SQL contact_instantly_campaigns table
        try {
            if (uploaded > 0) {
                // Get SQL client_id
                const clientResult = await pool.query(
                    'SELECT id FROM clients WHERE agency_id = $1 AND name = $2',
                    [uid, clientId]
                );
                
                if (clientResult.rows.length > 0) {
                    const sqlClientId = clientResult.rows[0].id;
                    
                    // Get campaign SQL ID
                    const campaignResult = await pool.query(
                        'SELECT id FROM instantly_campaigns WHERE agency_id = $1 AND instantly_campaign_id = $2',
                        [uid, campaignId]
                    );
                    
                    if (campaignResult.rows.length > 0) {
                        const sqlCampaignId = campaignResult.rows[0].id;
                        
                        // Get contact IDs for uploaded leads (only valid/risky emails)
                        const emails = verified.slice(0, uploaded).map(row => row.email).filter(Boolean);
                        if (emails.length > 0) {
                            const contactsResult = await pool.query(
                                `SELECT id, email FROM contacts 
                                 WHERE client_id = $1 AND email = ANY($2) 
                                 AND email_status IN ('valid', 'risky')`,
                                [sqlClientId, emails]
                            );
                            
                            if (contactsResult.rows.length > 0) {
                                // Bulk insert into contact_instantly_campaigns
                                const values = contactsResult.rows.map((_, idx) => {
                                    const offset = idx * 3;
                                    return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
                                }).join(', ');
                                
                                const params = contactsResult.rows.flatMap(contact => [
                                    contact.id,
                                    sqlCampaignId,
                                    jobId
                                ]);
                                
                                await pool.query(
                                    `INSERT INTO contact_instantly_campaigns 
                                        (contact_id, campaign_id, job_id, upload_source, added_at)
                                     VALUES ${values}
                                     ON CONFLICT (contact_id, campaign_id) 
                                     DO UPDATE SET 
                                        job_id = COALESCE(contact_instantly_campaigns.job_id, EXCLUDED.job_id),
                                        added_at = now()`,
                                    params
                                );
                                
                                console.log(`[SQL] Tracked ${contactsResult.rows.length} contacts in campaign ${sqlCampaignId}`);
                            }
                        }
                    } else {
                        console.warn('[SQL] Campaign not found in SQL, skipping tracking', { campaignId });
                    }
                }
            }
        } catch (sqlError) {
            console.error('[SQL] Failed to track upload in SQL:', sqlError?.message || sqlError);
            // Don't fail the request if SQL tracking fails
        }
        
        return res.json({ count: uploaded, total: verified.length });
    } catch (error) {
        console.error('Upload to Instantly error:', error);
        await recordUploadFailure('Failed to upload to Instantly.');
        return res.status(500).json({ error: 'Failed to upload to Instantly.' });
    }
});

// POST /api/jobs/:jobId/mark-manual-upload - Mark contacts as manually uploaded
router.post('/jobs/:jobId/mark-manual-upload', async (req, res) => {
    try {
        const { jobId } = req.params;
        const { idToken, clientId, campaignId, notes } = req.body;

        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!campaignId) return res.status(400).json({ error: 'Missing campaign ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        // Get SQL client_id
        const clientResult = await pool.query(
            'SELECT id FROM clients WHERE agency_id = $1 AND name = $2',
            [uid, clientId]
        );

        if (clientResult.rows.length === 0) {
            return res.status(404).json({ error: 'Client not found in SQL.' });
        }

        const sqlClientId = clientResult.rows[0].id;

        // Verify campaign exists and get its info
        const campaignResult = await pool.query(
            'SELECT id, name FROM instantly_campaigns WHERE id = $1 AND agency_id = $2 AND client_id = $3',
            [campaignId, uid, sqlClientId]
        );

        if (campaignResult.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found or access denied.' });
        }

        const campaignName = campaignResult.rows[0].name;

        // Get qualified contacts for this job
        // Criteria: valid/risky email + non-empty/non-invalid personalization
        const contactsResult = await pool.query(
            `SELECT id, email, full_name, personalization_first_line
             FROM contacts 
             WHERE client_id = $1 
             AND job_id = $2
             AND (email_status = 'valid' OR email_status = 'risky')
             AND personalization_first_line IS NOT NULL
             AND personalization_first_line != 'invalid'
             AND personalization_first_line != ''
             ORDER BY created_at DESC`,
            [sqlClientId, jobId]
        );

        if (contactsResult.rows.length === 0) {
            return res.status(404).json({ 
                error: 'No qualified contacts found.',
                message: 'Contacts must have valid/risky email status and valid personalization.'
            });
        }

        // Bulk insert into contact_instantly_campaigns with manual source
        const values = contactsResult.rows.map((_, idx) => {
            const offset = idx * 5;
            return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
        }).join(', ');

        const params = contactsResult.rows.flatMap(contact => [
            contact.id,
            campaignId,
            'manual',
            uid,
            jobId
        ]);

        // Add notes parameter if provided
        let query;
        if (notes && notes.trim()) {
            const notesParams = contactsResult.rows.map(() => notes.trim());
            params.push(...notesParams);
            
            const valuesWithNotes = contactsResult.rows.map((_, idx) => {
                const offset = idx * 5;
                const notesOffset = contactsResult.rows.length * 5 + idx;
                return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${notesOffset + 1})`;
            }).join(', ');
            
            query = `
                INSERT INTO contact_instantly_campaigns 
                    (contact_id, campaign_id, upload_source, uploaded_by, job_id, notes)
                VALUES ${valuesWithNotes}
                ON CONFLICT (contact_id, campaign_id) DO NOTHING
                RETURNING contact_id
            `;
        } else {
            query = `
                INSERT INTO contact_instantly_campaigns 
                    (contact_id, campaign_id, upload_source, uploaded_by, job_id)
                VALUES ${values}
                ON CONFLICT (contact_id, campaign_id) DO NOTHING
                RETURNING contact_id
            `;
        }

        const result = await pool.query(query, params);

        console.log(`[Manual Upload] Marked ${result.rows.length} contacts for job ${jobId} to campaign ${campaignName}`);

        res.json({
            success: true,
            contactCount: result.rows.length,
            campaignName,
            campaignId
        });

    } catch (error) {
        console.error('Error marking manual upload:', error);
        res.status(500).json({ error: 'Failed to mark manual upload.' });
    }
});

// GET /api/jobs/batch/upload-status - Get upload status for multiple jobs
router.post('/jobs/batch/upload-status', async (req, res) => {
    try {
        const { jobIds, clientId, agencyId } = req.body;

        if (!Array.isArray(jobIds) || jobIds.length === 0) {
            return res.status(400).json({ error: 'jobIds must be a non-empty array.' });
        }

        if (!clientId || !agencyId) {
            return res.status(400).json({ error: 'Missing clientId or agencyId.' });
        }

        // Get SQL client_id
        const clientResult = await pool.query(
            'SELECT id FROM clients WHERE agency_id = $1 AND name = $2',
            [agencyId, clientId]
        );

        if (clientResult.rows.length === 0) {
            return res.json({ statusMap: {} });
        }

        const sqlClientId = clientResult.rows[0].id;

        // Get upload status for all jobs in a single query
        const uploadsResult = await pool.query(
            `SELECT 
                cic.job_id,
                ic.id as campaign_id,
                ic.name as campaign_name,
                ic.instantly_campaign_id,
                cic.upload_source,
                COUNT(cic.contact_id) as contact_count,
                MIN(cic.added_at) as first_uploaded_at,
                MAX(cic.added_at) as last_uploaded_at,
                cic.notes
             FROM contact_instantly_campaigns cic
             JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
             JOIN contacts c ON c.id = cic.contact_id
             WHERE cic.job_id = ANY($1::text[])
             AND ic.agency_id = $2 
             AND c.client_id = $3
             GROUP BY cic.job_id, ic.id, ic.name, ic.instantly_campaign_id, cic.upload_source, cic.notes
             ORDER BY cic.job_id, last_uploaded_at DESC`,
            [jobIds, agencyId, sqlClientId]
        );

        // Group results by job ID
        const statusMap = {};
        for (const row of uploadsResult.rows) {
            const jobId = row.job_id;
            if (!statusMap[jobId]) {
                statusMap[jobId] = [];
            }
            statusMap[jobId].push(row);
        }

        res.json({ statusMap });

    } catch (error) {
        console.error('Error fetching batch upload status:', error);
        res.status(500).json({ error: 'Failed to fetch upload status.' });
    }
});

// GET /api/jobs/:jobId/upload-status - Get upload status for a job (legacy, prefer batch endpoint)
router.get('/jobs/:jobId/upload-status', async (req, res) => {
    try {
        const { jobId } = req.params;
        const { clientId, agencyId } = req.query;

        if (!clientId || !agencyId) {
            return res.status(400).json({ error: 'Missing clientId or agencyId query parameters.' });
        }

        // Get SQL client_id
        const clientResult = await pool.query(
            'SELECT id FROM clients WHERE agency_id = $1 AND name = $2',
            [agencyId, clientId]
        );

        if (clientResult.rows.length === 0) {
            return res.json({ uploads: [] });
        }

        const sqlClientId = clientResult.rows[0].id;

        // Get upload status aggregated by campaign and source
        const uploadsResult = await pool.query(
            `SELECT 
                ic.id as campaign_id,
                ic.name as campaign_name,
                ic.instantly_campaign_id,
                cic.upload_source,
                COUNT(cic.contact_id) as contact_count,
                MIN(cic.added_at) as first_uploaded_at,
                MAX(cic.added_at) as last_uploaded_at,
                cic.notes
             FROM contact_instantly_campaigns cic
             JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
             JOIN contacts c ON c.id = cic.contact_id
             WHERE cic.job_id = $1 
             AND ic.agency_id = $2 
             AND c.client_id = $3
             GROUP BY ic.id, ic.name, ic.instantly_campaign_id, cic.upload_source, cic.notes
             ORDER BY last_uploaded_at DESC`,
            [jobId, agencyId, sqlClientId]
        );

        res.json({ uploads: uploadsResult.rows });

    } catch (error) {
        console.error('Error fetching upload status:', error);
        res.status(500).json({ error: 'Failed to fetch upload status.' });
    }
});

// GET /api/jobs/:jobId/qualified-count - Get count of qualified contacts for manual upload
router.get('/jobs/:jobId/qualified-count', async (req, res) => {
    try {
        const { jobId } = req.params;
        const { clientId, agencyId } = req.query;

        if (!clientId || !agencyId) {
            return res.status(400).json({ error: 'Missing clientId or agencyId query parameters.' });
        }

        // Get or create SQL client_id using the Firestore client slug
        const sqlClientId = await getOrCreateClient(agencyId, clientId);

        // Get counts for qualified contacts from this specific job
        const countsResult = await pool.query(
            `SELECT 
                COUNT(*) FILTER (
                    WHERE (email_status = 'valid' OR email_status = 'risky')
                    AND personalization_first_line IS NOT NULL
                    AND personalization_first_line != 'invalid'
                    AND personalization_first_line != ''
                ) as qualified_count,
                COUNT(*) as total_count
             FROM contacts 
             WHERE client_id = $1 AND job_id = $2`,
            [sqlClientId, jobId]
        );

        res.json({
            qualifiedCount: parseInt(countsResult.rows[0].qualified_count) || 0,
            totalCount: parseInt(countsResult.rows[0].total_count) || 0
        });

    } catch (error) {
        console.error('Error fetching qualified count:', error);
        res.status(500).json({ error: 'Failed to fetch qualified count.' });
    }
});

// DELETE /api/jobs/:jobId/revert-manual-upload - Revert manual upload
router.delete('/jobs/:jobId/revert-manual-upload', async (req, res) => {
    try {
        const { jobId } = req.params;
        const { idToken, campaignId } = req.body;

        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!campaignId) return res.status(400).json({ error: 'Missing campaign ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        // Delete only manual uploads for this job and campaign by this user
        const result = await pool.query(
            `DELETE FROM contact_instantly_campaigns 
             WHERE job_id = $1 
             AND campaign_id = $2 
             AND upload_source = 'manual'
             AND uploaded_by = $3
             RETURNING contact_id`,
            [jobId, campaignId, uid]
        );

        console.log(`[Manual Upload Revert] Removed ${result.rows.length} contacts from campaign ${campaignId} for job ${jobId}`);

        res.json({
            success: true,
            removedCount: result.rows.length
        });

    } catch (error) {
        console.error('Error reverting manual upload:', error);
        res.status(500).json({ error: 'Failed to revert manual upload.' });
    }
});

// POST /api/jobs/check-domains - Check which domains already exist in the database
router.post('/jobs/check-domains', async (req, res) => {
    try {
        const { domains, clientId, agencyId } = req.body;

        if (!Array.isArray(domains) || domains.length === 0) {
            return res.status(400).json({ error: 'domains must be a non-empty array.' });
        }

        if (!clientId || !agencyId) {
            return res.status(400).json({ error: 'Missing clientId or agencyId.' });
        }

        // Normalize domains (lowercase, trim, remove protocols) and dedupe
        const normalizedDomainsRaw = domains.map(d => {
            if (!d) return '';
            return String(d)
                .toLowerCase()
                .trim()
                .replace(/^https?:\/\//, '')
                .replace(/^www\./, '')
                .split('/')[0]
                .split('?')[0];
        }).filter(Boolean);
        const uniqueDomains = Array.from(new Set(normalizedDomainsRaw));

        // Get SQL client_id
        const clientResult = await pool.query(
            'SELECT id FROM clients WHERE agency_id = $1 AND name = $2',
            [agencyId, clientId]
        );

        if (clientResult.rows.length === 0) {
            // Client doesn't exist yet, all domains are new
            return res.json({
                totalDomains: normalizedDomainsRaw.length,
                uniqueDomains: uniqueDomains.length,
                existingDomains: 0,
                newDomains: uniqueDomains.length,
                run: 0,
                notRun: 0,
                withFounders: 0,
                withEmails: 0,
                withPersonalization: 0
            });
        }

        const sqlClientId = clientResult.rows[0].id;

        // First, find which domains exist in the database
        const existingDomainsQuery = `
            SELECT DISTINCT domain_normalized 
            FROM companies 
            WHERE client_id = $1 
            AND domain_normalized = ANY($2::text[])
        `;
        const existingResult = await pool.query(existingDomainsQuery, [sqlClientId, uniqueDomains]);
        const existingDomainsList = existingResult.rows.map(row => row.domain_normalized);
        const existingCount = existingDomainsList.length;
        const newCount = uniqueDomains.length - existingCount;

        // If no existing domains, return zeros for all enrichment stats
        if (existingCount === 0) {
            return res.json({
                totalDomains: normalizedDomainsRaw.length,
                uniqueDomains: uniqueDomains.length,
                existingDomains: 0,
                newDomains: newCount,
                run: 0,
                notRun: 0,
                withFounders: 0,
                withEmails: 0,
                withPersonalization: 0
            });
        }

        // Now check enrichment stats for ONLY the existing domains
        const enrichmentQuery = `
            SELECT 
                COUNT(DISTINCT CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM contacts ct 
                        WHERE ct.company_id = c.id 
                        AND ct.job_id IS NOT NULL
                    ) THEN c.domain_normalized 
                END) as run_count,
                COUNT(DISTINCT CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM contacts ct 
                        WHERE ct.company_id = c.id 
                        AND ct.full_name IS NOT NULL 
                        AND ct.full_name != ''
                        AND ct.job_id IS NOT NULL
                    ) THEN c.domain_normalized 
                END) as with_founders_count,
                COUNT(DISTINCT CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM contacts ct 
                        WHERE ct.company_id = c.id 
                        AND ct.email IS NOT NULL 
                        AND ct.email != ''
                        AND ct.job_id IS NOT NULL
                    ) THEN c.domain_normalized 
                END) as with_emails_count,
                COUNT(DISTINCT CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM contacts ct 
                        WHERE ct.company_id = c.id 
                        AND ct.personalization_first_line IS NOT NULL 
                        AND ct.personalization_first_line != ''
                        AND ct.job_id IS NOT NULL
                    ) THEN c.domain_normalized 
                END) as with_personalization_count
            FROM companies c
            WHERE c.client_id = $1 
            AND c.domain_normalized = ANY($2::text[])
        `;

        const enrichmentResult = await pool.query(enrichmentQuery, [sqlClientId, existingDomainsList]);
        const enrichment = enrichmentResult.rows[0];

        const runCount = parseInt(enrichment.run_count) || 0;
        const notRunCount = existingCount - runCount;

        res.json({
            totalDomains: normalizedDomainsRaw.length,
            uniqueDomains: uniqueDomains.length,
            existingDomains: existingCount,
            newDomains: newCount,
            run: runCount,
            notRun: notRunCount,
            withFounders: parseInt(enrichment.with_founders_count) || 0,
            withEmails: parseInt(enrichment.with_emails_count) || 0,
            withPersonalization: parseInt(enrichment.with_personalization_count) || 0
        });

    } catch (error) {
        console.error('Error checking domains:', error);
        res.status(500).json({ error: 'Failed to check domains.' });
    }
});

// Personalizer endpoint - simplified pipeline for Shopify personalization
const personalizerFields = upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'idToken', maxCount: 1 },
    { name: 'clientId', maxCount: 1 },
    { name: 'productsToPull', maxCount: 1 },
    { name: 'checkKlaviyo', maxCount: 1 },
    { name: 'removeB2B', maxCount: 1 }
]);

router.post('/jobs/personalizer', personalizerFields, async (req, res) => {
    try {
        if (!req.files?.file || !req.files.file[0]) {
            return res.status(400).json({ error: 'Missing CSV file upload.' });
        }

        const idToken = req.body.idToken;
        if (!idToken) {
            return res.status(400).json({ error: 'Missing ID token.' });
        }

        // Verify the ID token
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const uid = decodedToken.uid;

        // Fetch API keys from Firestore
        const userDoc = await firestore.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.status(400).json({ error: 'User not found.' });
        }
        const userData = userDoc.data();
        const apiKeys = {
            openai: userData?.openai_key || '',
            serper: userData?.serper_key || '',
            kitt: userData?.trykitt_key || ''
        };

        if (!apiKeys.openai) {
            return res.status(400).json({ error: 'Missing OpenAI API key in user vault.' });
        }

        const file = req.files.file[0];
        const clientId = (req.body.clientId || '').toString().trim();
        const productsToPull = parseInt(req.body.productsToPull || '3', 10);
        const checkKlaviyo = String(req.body.checkKlaviyo || '').toLowerCase() === 'true';
        const removeB2B = String(req.body.removeB2B || '').toLowerCase() === 'true';

        // Create job ID and paths
        const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const jobDir = path.join(TMP_ROOT, 'jobs', jobId);
        fs.mkdirSync(jobDir, { recursive: true });

        const inputCsv = path.join(jobDir, 'input.csv');
        const outputCsv = path.join(jobDir, 'personalized.csv');

        // Write uploaded file
        fs.writeFileSync(inputCsv, file.buffer);

        // Create job record in Firestore
        const jobRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId).collection('jobs').doc(jobId);
        await jobRef.set({
            id: jobId,
            fileName: file.originalname,
            status: 'running',
            stages: {
                shopifyDetection: { status: 'pending', startedAt: null, completedAt: null, summary: null, error: null, progress: null },
                klaviyoDetection: { status: 'pending', startedAt: null, completedAt: null, summary: null, error: null, progress: null },
                productFetch: { status: 'pending', startedAt: null, completedAt: null, summary: null, error: null, progress: null },
                personalization: { status: 'pending', startedAt: null, completedAt: null, summary: null, error: null, progress: null }
            },
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            completedAt: null,
            clientId,
            config: {
                productsToPull,
                checkKlaviyo,
                removeB2B
            }
        });

        // Helper to update stage status
        const updateStage = async (stage, updates) => {
            const updateData = {};
            Object.entries(updates).forEach(([key, value]) => {
                if (key === 'startedAt' || key === 'completedAt') {
                    updateData[`stages.${stage}.${key}`] = admin.firestore.FieldValue.serverTimestamp();
                } else {
                    updateData[`stages.${stage}.${key}`] = value;
                }
            });
            await jobRef.update(updateData).catch(err => {
                console.error(`[${jobId}] Failed to update stage ${stage}:`, err);
            });
        };

        // Run pipeline asynchronously
        (async () => {
            try {
                // Stage 1: Shopify Detection
                await updateStage('shopifyDetection', { status: 'running', startedAt: true });

                const log = (message, meta) => {
                    console.log(`[${jobId}] ${message || ''}`);
                    // Update progress in Firestore if meta contains progress
                    if (meta?.progress) {
                        const stage = meta.progress.stage;
                        updateStage(stage, { progress: meta.progress }).catch(() => {});
                    }
                };

                const result = await runPersonalizerPipeline({
                    inputCsv,
                    outputCsv,
                    apiKeys,
                    log,
                    productsToPull,
                    checkKlaviyo,
                    removeB2B,
                    jobRef,
                    updateStage
                });

                // Update final status
                await jobRef.update({
                    status: 'completed',
                    completedAt: admin.firestore.FieldValue.serverTimestamp(),
                    result: {
                        shopifyStores: result.shopifyStores,
                        klaviyoStores: result.klaviyoStores,
                        productsFetched: result.productsFetched,
                        personalized: result.personalized,
                        estimatedCost: result.estimatedCost
                    }
                });

                console.log(`[${jobId}] ✓ Pipeline completed successfully`);

            } catch (error) {
                console.error(`[${jobId}] Pipeline error:`, error);
                await jobRef.update({
                    status: 'failed',
                    error: error.message,
                    completedAt: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        })();

        res.status(201).json({ 
            jobId,
            message: 'Personalizer job started'
        });

    } catch (error) {
        console.error('Personalizer job creation error:', error);
        res.status(500).json({ error: 'Failed to create personalizer job.' });
    }
});

// Download personalizer results
router.get('/jobs/personalizer/:jobId/result', async (req, res) => {
    const { jobId } = req.params;
    
    try {
        const jobDir = path.join(TMP_ROOT, 'jobs', jobId);
        const outputCsv = path.join(jobDir, 'personalized.csv');
        
        if (!fs.existsSync(outputCsv)) {
            return res.status(404).json({ error: 'Personalization results not found' });
        }
        
        const filename = `personalized-${jobId}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        const fileStream = fs.createReadStream(outputCsv);
        fileStream.pipe(res);
        
    } catch (error) {
        console.error('Personalizer result download error:', error);
        res.status(500).json({ error: 'Failed to download results' });
    }
});

export default router;
