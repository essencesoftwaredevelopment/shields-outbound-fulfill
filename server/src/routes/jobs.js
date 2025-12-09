import express from 'express';
import multer from 'multer';
import fs from 'fs';
import { admin, firestore } from '../config/firebase.js';
import { buildUnifiedRows } from '../utils/csv.js';
import { attachCampaignToLeads, filterAndWriteProcessedDomains, incrementCampaignLeadCount } from '../services/leads.js';
import { createJobRecord, jobs, logJob, markCancelled, processJob, resolveJobPaths, serializeJob } from '../services/jobPipeline.js';

const router = express.Router();

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
    { name: 'industry', maxCount: 1 },
    { name: 'personalizeFirstLine', maxCount: 1 }
]);

// Get CSV preview for column mapping
router.post('/jobs/:id/csv-preview', async (req, res) => {
    try {
        const { idToken, clientId } = req.body || {};
        const jobId = req.params.id;

        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

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

        if (!apiKeys.openai || !apiKeys.serper || !apiKeys.kitt) {
            return res.status(400).json({ error: 'Missing API keys in user vault.' });
        }

        const file = req.files.file[0];
        const clientId = (req.body.clientId || '').toString().trim();
        const dedupeStrategy = (req.body.dedupeStrategy || 'skip').toString(); // 'skip' | 'include'
        const rawSkipFounder = String(req.body.skipFounderFinder || '').toLowerCase() === 'true';
        const rawFindFounder = String(req.body.findFounder ?? 'true').toLowerCase() !== 'false';
        const skipFounderFinder = rawSkipFounder || !rawFindFounder;
        const industry = (req.body.industry || req.body.nicheId || '').toString().trim();
        const nicheId = (req.body.nicheId || '').toString().trim();
        const nicheLabel = (req.body.nicheLabel || '').toString().trim();
        const personalizeFirstLine = String(req.body.personalizeFirstLine || '').toLowerCase() === 'true';
        const job = createJobRecord(file.buffer, file.originalname, apiKeys, uid, clientId, dedupeStrategy, {
            skipFounderFinder,
            findFounder: rawFindFounder,
            industry,
            nicheId,
            nicheLabel,
            personalizeFirstLine,
        });
        logJob(job, `Job queued with file ${job.fileName} for user ${uid}`);

        // Calculate dedupe stats synchronously before responding
        try {
            const { filtered: filteredDomainsPath, stats: dedupeStats } = await filterAndWriteProcessedDomains({
                uid: job.uid,
                clientId: job.clientId,
                jobId: job.id,
                domainsCsvPath: job.paths.domains,
                dedupeStrategy: job.dedupeStrategy
            });
            job.dedupeStats = dedupeStats;
            job.paths.filtered = filteredDomainsPath; // Store filtered path for processJob to use
            logJob(job, `Deduplication complete: ${dedupeStats.total} total, ${dedupeStats.skipped} skipped, ${dedupeStats.new} new`);
        } catch (err) {
            console.error('Deduplication error:', err);
            // Continue with job processing even if deduplication fails
        }

        processJob(job);
        res.status(201).json({ jobId: job.id, job: serializeJob(job) });
    } catch (error) {
        console.error('Job creation error:', error);
        res.status(500).json({ error: 'Failed to create job.' });
    }
});

router.get('/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.json({ job: serializeJob(job) });
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

        const job = jobs.get(jobId);
        if (!job) {
            return res.status(404).json({ error: 'Job not found.' });
        }
        if (job.uid !== uid || job.clientId !== clientId) {
            return res.status(403).json({ error: 'Unauthorized to stop this job.' });
        }
        if (job.cancelled || job.status === 'cancelled') {
            return res.json({ status: 'cancelled', message: 'Job already cancelled.' });
        }

        job.cancelled = true;
        markCancelled(job, 'Cancelled by user');

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

router.get('/jobs/:id/result', async (req, res) => {
    const jobId = req.params.id;
    const scopeParam = (req.query?.scope || '').toString() === 'valid' ? 'valid' : 'all';
    const { job, finalPath } = resolveJobPaths(jobId);

    if (!fs.existsSync(finalPath)) {
        return res.status(404).json({ error: 'Result file missing' });
    }
    if (job && job.status !== 'completed') {
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
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'Job not found' })}\n\n`);
        return res.end();
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
        const { idToken, clientId, campaignId, columnMapping } = req.body || {};
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
                        leads
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
                await attachCampaignToLeads({ uid, clientId, campaignId, rows: verified.slice(0, uploaded) });
                await incrementCampaignLeadCount({ uid, clientId, campaignId, delta: uploaded });
            }
        } catch (firestoreError) {
            console.warn('Failed to persist campaign lead linkage/counts:', firestoreError?.message || firestoreError);
        }
        return res.json({ count: uploaded, total: verified.length });
    } catch (error) {
        console.error('Upload to Instantly error:', error);
        await recordUploadFailure('Failed to upload to Instantly.');
        return res.status(500).json({ error: 'Failed to upload to Instantly.' });
    }
});

export default router;
