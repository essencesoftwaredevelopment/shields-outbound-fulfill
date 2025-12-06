import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { parse as csvParse } from 'csv-parse';
import admin from 'firebase-admin';

import { runFounderFinder } from './services/founderFinder.js';
import { runEmailFinder } from './services/emailFinder.js';
import { runEmailVerifier } from './services/emailVerifier.js';
import { runPersonalization } from './services/personalizer.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Initialize Firebase Admin
const serviceAccountPath = path.join(__dirname, '..', '.secrets', 'service-account.json');
admin.initializeApp({
    credential: admin.credential.cert(require(serviceAccountPath)),
    projectId: 'shields-outbound-fulfill'
});
const firestore = admin.firestore();

function getLeadRef(uid, clientId, domain) {
    return firestore
        .collection('users').doc(uid)
        .collection('clients').doc(clientId)
        .collection('leads').doc(domain.toLowerCase());
}



async function upsertLead(uid, clientId, domain, data) {
    if (!uid || !clientId || !domain) return;
    const leadRef = getLeadRef(uid, clientId, domain);
    await leadRef.set({
        domain: domain.toLowerCase(),
        ...data,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

async function upsertLeadsFromCsv({ uid, clientId, csvPath, type, dedupeStrategy = 'skip' }) {
    if (!fs.existsSync(csvPath)) return;
    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => rows.push(row))
            .on('end', resolve)
            .on('error', reject);
    });

    // Upsert all leads from CSV regardless of dedupeStrategy
    // (dedupeStrategy only affects which domains make it into the CSV via filterAndWriteProcessedDomains)
    const writer = firestore.bulkWriter();
    writer.onWriteError((error) => {
        const code = error?.code || '';
        const willRetry = error?.failedAttempts < 3;
        if (willRetry) return true;
        console.warn('BulkWriter error (no retry):', code, error?.message);
        return false;
    });

    for (const row of rows) {
        const domain = String(row.domain || '').trim();
        if (!domain) continue;
        const ref = getLeadRef(uid, clientId, domain);
        let payload = {};
        if (type === 'founders') {
            payload = { founder_name: String(row.founder_name || '').trim() };
        } else if (type === 'emails') {
            payload = {
                founder_name: String(row.founder_name || '').trim(),
                email: String(row.email || '').trim(),
                email_status: String(row.lookup_status || '').trim()
            };
        } else if (type === 'verification') {
            payload = {
                founder_name: String(row.founder_name || '').trim(),
                email: String(row.email || '').trim(),
                email_status: String(row.email_status || '').trim()
            };
        } else if (type === 'personalization') {
            payload = {
                personalization_url: String(row.url || '').trim(),
                personalization_title: String(row.title || '').trim(),
                personalization_first_line: String(row.first_line || '').trim()
            };
        }
        writer.set(ref, {
            domain: domain.toLowerCase(),
            ...payload,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    }

    await writer.close();
}

const PORT = process.env.PORT || 4000;
const TMP_ROOT = path.join(__dirname, '..', '..', 'tmp', 'jobs');
fs.mkdirSync(TMP_ROOT, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const uploadFields = upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'idToken', maxCount: 1 },
    { name: 'clientId', maxCount: 1 },
    { name: 'nicheId', maxCount: 1 },
    { name: 'nicheLabel', maxCount: 1 }
]);

const jobs = new Map();
// Get CSV preview for column mapping
app.post('/api/jobs/:id/csv-preview', async (req, res) => {
    try {
        const { idToken, clientId } = req.body || {};
        const jobId = req.params.id;

        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        let job = jobs.get(jobId);
        // Resolve file paths even if job object is missing (e.g., server restarted)
        const jobDir = job?.paths?.dir || path.join(TMP_ROOT, jobId);
        const finalPath = job?.paths?.final || path.join(jobDir, 'final.csv');
        const personalizedPath = job?.paths?.personalized || path.join(jobDir, 'personalized.csv');

        if (!fs.existsSync(finalPath)) return res.status(404).json({ error: 'Result file missing' });

        // Read final.csv (verification results)
        const finalContent = fs.readFileSync(finalPath, 'utf-8');
        const finalRows = [];
        await new Promise((resolve, reject) => {
            const parser = csvParse({ columns: true, skip_empty_lines: true });
            parser.on('data', (row) => finalRows.push(row));
            parser.on('end', resolve);
            parser.on('error', reject);
            parser.write(finalContent);
            parser.end();
        });

        // Read personalized.csv if available and merge personalization fields by domain
        let personalizedByDomain = new Map();
        if (fs.existsSync(personalizedPath)) {
            const personalizedContent = fs.readFileSync(personalizedPath, 'utf-8');
            await new Promise((resolve, reject) => {
                const parser = csvParse({ columns: true, skip_empty_lines: true });
                parser.on('data', (row) => {
                    const domainKey = String(row.domain || '').toLowerCase();
                    if (domainKey) personalizedByDomain.set(domainKey, row);
                });
                parser.on('end', resolve);
                parser.on('error', reject);
                parser.write(personalizedContent);
                parser.end();
            });
        }

        // Build unified rows with derived first_name, last_name and personalization fields
        const unified = finalRows.map(r => {
            const domainKey = String(r.domain || '').toLowerCase();
            const founder = String(r.founder_name || '').trim();
            const parts = founder.split(/\s+/);
            const first_name = parts[0] || '';
            const last_name = parts.length > 1 ? parts.slice(1).join(' ') : '';
            const personal = personalizedByDomain.get(domainKey) || {};

            // Debug log for first row
            if (finalRows.indexOf(r) === 0) {
                console.log(`[CSV Preview] First row from final.csv:`, r);
                console.log(`[CSV Preview] Personalized data for ${domainKey}:`, personal);
            }

            return {
                domain: r.domain || '',
                email: r.email || '',
                email_status: r.email_status || r.lookup_status || '',
                first_name,
                last_name,
                personalization: personal.first_line || personal.personalization_first_line || '',
                product_title: personal.title || personal.personalization_title || ''
            };
        });

        const headers = ['domain', 'first_name', 'last_name', 'personalization', 'product_title', 'email', 'email_status'];
        const previewRows = unified.slice(0, 3);

        res.json({ headers, previewRows });
    } catch (error) {
        console.error('CSV preview error:', error);
        res.status(500).json({ error: 'Failed to load CSV preview.' });
    }
});

const initialStageState = () => ({
    status: 'pending',
    startedAt: null,
    completedAt: null,
    summary: null,
    error: null,
    progress: null
});

function broadcast(job, payload) {
    job.streams.forEach(stream => {
        try {
            stream.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch (err) {
            console.error('SSE stream error', err);
        }
    });
}

function pushState(job) {
    const state = {
        id: job.id,
        status: job.status,
        stages: job.stages,
        error: job.error,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        clientId: job.clientId,
        dedupeStats: job.dedupeStats || null,
        fileName: job.fileName
    };
    broadcast(job, { type: 'state', state });
}

function log(job, message = null, meta = {}) {
    if (message) {
        const entry = { message, meta, timestamp: new Date().toISOString() };
        job.logs.push(entry);
        if (job.logs.length > 500) {
            job.logs.shift();
        }
        console.log(`[${job.id}] ${message}`);
        broadcast(job, { type: 'log', log: entry });
    }

    const progress = meta?.progress;
    if (progress?.stage && job.stages[progress.stage]) {
        const { stage, ...rest } = progress;
        job.stages[stage] = {
            ...job.stages[stage],
            progress: {
                ...(job.stages[stage].progress || {}),
                ...rest
            }
        };
        pushState(job);
    }
}

function updateStage(job, stageKey, updates) {
    job.stages[stageKey] = {
        ...job.stages[stageKey],
        ...updates
    };
    pushState(job);
}

function createJobRecord(fileBuffer, originalName, apiKeys, uid, clientId, dedupeStrategy = 'skip') {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = path.join(TMP_ROOT, id);
    fs.mkdirSync(dir, { recursive: true });

    const inputPath = path.join(dir, 'domains.csv');
    fs.writeFileSync(inputPath, fileBuffer);

    const job = {
        id,
        status: 'queued',
        createdAt: new Date().toISOString(),
        completedAt: null,
        error: null,
        fileName: originalName,
        apiKeys,
        uid,
        clientId,
        dedupeStrategy,
        stages: {
            founders: initialStageState(),
            emailDiscovery: initialStageState(),
            verification: initialStageState(),
            personalization: initialStageState()
        },
        logs: [],
        streams: [],
        paths: {
            dir,
            domains: inputPath,
            founders: path.join(dir, 'founders.csv'),
            emails: path.join(dir, 'emails.csv'),
            final: path.join(dir, 'final.csv'),
            personalized: path.join(dir, 'personalized.csv')
        }
    };

    jobs.set(id, job);
    return job;
}

async function filterAndWriteProcessedDomains({ uid, clientId, jobId, domainsCsvPath, dedupeStrategy = 'skip' }) {
    if (!uid || !domainsCsvPath || !clientId) {
        console.warn(`[${jobId}] Missing uid/clientId/domainsCsvPath. uid=${uid}, clientId=${clientId}, domainsCsvPath=${domainsCsvPath}`);
        return { filtered: domainsCsvPath, stats: { total: 0, skipped: 0, new: 0 } };
    }
    const clientRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId);
    const subRef = clientRef.collection('processed-domains');

    // Read all domains from CSV
    const domains = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(domainsCsvPath)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', (row) => {
                const domain = String(row.domain || '').trim();
                if (domain) domains.push(domain);
            })
            .on('end', resolve)
            .on('error', reject);
    });

    const stats = { total: domains.length, skipped: 0, new: 0 };

    // Build set of existing processed domains for uniqueness
    const processedSet = new Set();
    const existingSnap = await subRef.get();
    existingSnap.forEach(doc => {
        const domain = doc.data().domain || doc.id;
        if (domain) processedSet.add(String(domain).toLowerCase());
    });

    // Determine filtered list when skipping duplicates
    let filteredDomains = domains;
    if (dedupeStrategy === 'skip') {
        filteredDomains = domains.filter(d => !processedSet.has(d.toLowerCase()));
        stats.skipped = domains.length - filteredDomains.length;
        stats.new = filteredDomains.length;
    } else {
        // include: process ALL domains (no filtering), just track new vs existing in stats
        filteredDomains = domains; // Keep all domains for processing
        const uniqueDomains = new Set(domains.map(d => d.toLowerCase()));
        let newCount = 0;
        uniqueDomains.forEach(d => { if (!processedSet.has(d)) newCount += 1; });
        stats.new = newCount; // How many are truly new
        stats.skipped = 0; // Don't skip any when strategy is 'include'
    }

    // Write to processed-domains ensuring one doc per domain (unique key)
    const writePromises = (dedupeStrategy === 'skip' ? filteredDomains : Array.from(new Set(domains.map(d => d.toLowerCase())))).map(async (domain) => {
        const id = domain.toLowerCase();
        const ref = subRef.doc(id);
        try {
            await ref.set({
                domain: id,
                lastJobId: jobId,
                // optional list of jobs processed
                jobs: admin.firestore.FieldValue.arrayUnion(jobId),
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        } catch (err) {
            console.warn('processed-domains write error', err?.message);
        }
    });
    await Promise.all(writePromises);

    // Update client document with absolute total leads count based on processed-domains size
    try {
        const allProcessedSnap = await subRef.get();
        const total = allProcessedSnap.size;
        console.log(`[${jobId}] Updating client ${clientId} totalLeads=${total}`);
        await clientRef.set({
            totalLeads: total,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.warn(`[${jobId}] Failed to set client totalLeads count for clientId=${clientId}`, err?.message);
    }

    // Write filtered CSV if we filtered anything
    if (dedupeStrategy === 'skip' && stats.skipped > 0) {
        const filteredPath = domainsCsvPath.replace('.csv', '-filtered.csv');
        const writer = fs.createWriteStream(filteredPath);
        writer.write('domain\n');
        filteredDomains.forEach(domain => writer.write(`${domain}\n`));
        writer.end();
        await new Promise(resolve => writer.on('finish', resolve));
        return { filtered: filteredPath, stats };
    }

    return { filtered: domainsCsvPath, stats };
}

async function runStage(job, stageKey, handler) {
    updateStage(job, stageKey, { status: 'running', startedAt: new Date().toISOString(), error: null });
    try {
        const summary = await handler();
        updateStage(job, stageKey, { status: 'completed', completedAt: new Date().toISOString(), summary });
        return summary;
    } catch (err) {
        const message = err?.message || 'Unknown error';
        updateStage(job, stageKey, { status: 'error', completedAt: new Date().toISOString(), error: message });
        throw err;
    }
}

async function processJob(job) {
    job.status = 'running';
    pushState(job);
    log(job, 'Job started.');

    try {
        // Use pre-calculated filtered path if available (from job creation), otherwise calculate now
        let filteredDomainsPath = job.paths.filtered;
        if (!filteredDomainsPath) {
            const { filtered, stats: dedupeStats } = await filterAndWriteProcessedDomains({
                uid: job.uid,
                clientId: job.clientId,
                jobId: job.id,
                domainsCsvPath: job.paths.domains,
                dedupeStrategy: job.dedupeStrategy
            });
            filteredDomainsPath = filtered;
            job.dedupeStats = dedupeStats;
            log(job, `Deduplication: ${dedupeStats.total} total, ${dedupeStats.skipped} skipped, ${dedupeStats.new} new domains to process`);
        }

        // If all domains were filtered out AND we're using skip strategy, complete early
        if (job.dedupeStats && job.dedupeStats.new === 0 && job.dedupeStrategy === 'skip') {
            job.status = 'completed';
            job.completedAt = new Date().toISOString();
            pushState(job);
            log(job, 'Job completed: All domains were already processed (duplicates)');
            return;
        }

        await runStage(job, 'founders', () =>
            runFounderFinder({
                inputCsv: filteredDomainsPath,
                outputCsv: job.paths.founders,
                apiKeys: job.apiKeys,
                log: (message, meta) => log(job, message, meta)
            })
        );

        // Upsert leads with founder info
        await upsertLeadsFromCsv({ uid: job.uid, clientId: job.clientId, csvPath: job.paths.founders, type: 'founders', dedupeStrategy: job.dedupeStrategy });

        await runStage(job, 'emailDiscovery', () =>
            runEmailFinder({
                inputCsv: job.paths.founders,
                outputCsv: job.paths.emails,
                apiKeys: job.apiKeys,
                log: (message, meta) => log(job, message, meta)
            })
        );

        // Upsert leads with email lookup results
        await upsertLeadsFromCsv({ uid: job.uid, clientId: job.clientId, csvPath: job.paths.emails, type: 'emails', dedupeStrategy: job.dedupeStrategy });

        await runStage(job, 'verification', () =>
            runEmailVerifier({
                inputCsv: job.paths.emails,
                outputCsv: job.paths.final,
                apiKeys: job.apiKeys,
                log: (message, meta) => log(job, message, meta)
            })
        );

        // Upsert leads with verification status
        await upsertLeadsFromCsv({ uid: job.uid, clientId: job.clientId, csvPath: job.paths.final, type: 'verification', dedupeStrategy: job.dedupeStrategy });

        await runStage(job, 'personalization', () =>
            runPersonalization({
                inputCsv: job.paths.final,
                outputCsv: job.paths.personalized,
                apiKeys: job.apiKeys,
                log: (message, meta) => log(job, message, meta)
            })
        );

        // Upsert leads with personalization data
        await upsertLeadsFromCsv({ uid: job.uid, clientId: job.clientId, csvPath: job.paths.personalized, type: 'personalization', dedupeStrategy: job.dedupeStrategy });

        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        pushState(job);
        log(job, `Job completed. Final CSV ready at ${job.paths.final}`);
    } catch (err) {
        job.status = 'error';
        job.error = err?.message || 'Unexpected pipeline error';
        pushState(job);
        log(job, `Job failed: ${job.error}`);
    }
}

function serializeJob(job) {
    return {
        id: job.id,
        status: job.status,
        error: job.error,
        fileName: job.fileName,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        stages: job.stages,
        dedupeStats: job.dedupeStats || null,
        clientId: job.clientId
    };
}

app.post('/api/jobs', uploadFields, async (req, res) => {
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
        const job = createJobRecord(file.buffer, file.originalname, apiKeys, uid, clientId, dedupeStrategy);
        log(job, `Job queued with file ${job.fileName} for user ${uid}`);

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
            log(job, `Deduplication complete: ${dedupeStats.total} total, ${dedupeStats.skipped} skipped, ${dedupeStats.new} new`);
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

app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.json({ job: serializeJob(job) });
});

app.get('/api/jobs/:id/result', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    if (job.status !== 'completed') {
        return res.status(409).json({ error: 'Job not completed yet' });
    }
    if (!fs.existsSync(job.paths.final)) {
        return res.status(404).json({ error: 'Result file missing' });
    }
    res.download(job.paths.final, `results-${job.id}.csv`);
});

app.get('/api/jobs/:id/stream', (req, res) => {
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

app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// Create client via server (uses Admin SDK; bypasses client-side rules)
app.post('/api/clients', async (req, res) => {
    try {
        const { idToken, name, industry, instantly_key } = req.body || {};
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Client name is required.' });
        const allowedIndustries = new Set(['ecom', 'saas', 'agency', 'local']);
        const industryVal = typeof industry === 'string' ? industry : '';
        if (!allowedIndustries.has(industryVal)) return res.status(400).json({ error: 'Invalid industry.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const slug = name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 60);
        const clientRef = firestore.collection('users').doc(uid).collection('clients').doc(slug);
        await clientRef.set({
            id: slug,
            name: name.trim(),
            industry: industryVal,
            instantly_key: (instantly_key || '').toString().trim(),
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        res.status(201).json({ id: slug });
    } catch (error) {
        console.error('Client creation error:', error);
        res.status(500).json({ error: 'Failed to create client.' });
    }
});

async function deleteAllDocs(ref) {
    const batchSize = 300;
    let lastDoc = null;
    while (true) {
        let query = ref.orderBy('__name__').limit(batchSize);
        if (lastDoc) query = query.startAfter(lastDoc);
        const snap = await query.get();
        if (snap.empty) break;
        const batch = firestore.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        lastDoc = snap.docs[snap.docs.length - 1];
        if (snap.size < batchSize) break;
    }
}

// Delete a client and cascade delete known subcollections
app.post('/api/clients/:id/delete', async (req, res) => {
    try {
        const { idToken } = req.body || {};
        const clientId = req.params.id;
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client id.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const clientRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId);
        const subs = ['processed-domains', 'leads'];
        for (const sub of subs) {
            const colRef = clientRef.collection(sub);
            await deleteAllDocs(colRef);
        }
        await clientRef.delete();
        res.json({ ok: true });
    } catch (error) {
        console.error('Client cascade delete error:', error);
        res.status(500).json({ error: 'Failed to delete client.' });
    }
});

// Fetch Instantly campaigns for a client and store as subcollection 'campaigns'
app.post('/api/clients/:id/campaigns', async (req, res) => {
    try {
        console.log('[campaigns] incoming request', {
            path: req.path,
            params: req.params,
            hasBody: !!req.body,
        });
        const { idToken } = req.body || {};
        const clientId = req.params.id;
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client id.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;
        console.log('[campaigns] verified user', { uid, clientId });

        const clientRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId);
        const clientSnap = await clientRef.get();
        if (!clientSnap.exists) return res.status(404).json({ error: 'Client not found.' });
        const instantlyKey = (clientSnap.data()?.instantly_key || '').toString().trim();
        if (!instantlyKey) return res.status(400).json({ error: 'Client is missing Instantly API key.' });

        // Fetch campaigns from Instantly API (prefer v2) for last N days
        const daysStr = (req.query?.days || '').toString();
        const days = Number.isFinite(Number(daysStr)) && Number(daysStr) > 0 ? Number(daysStr) : 90;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        console.log('[campaigns] window', { days, since: since.toISOString() });
        let campaigns = [];
        async function fetchInstantlyCampaignsV2(key) {
            console.log('[campaigns] calling Instantly v2');
            const resp = await fetch('https://api.instantly.ai/api/v2/campaigns', {
                method: 'GET',
                headers: {
                    // v2 expects Authorization Bearer
                    'Authorization': `Bearer ${key}`,
                    'Accept': 'application/json'
                }
            });
            console.log('[campaigns] v2 response', { status: resp.status });
            if (!resp.ok) {
                const msg = await resp.text().catch(() => '');
                throw new Error(`Instantly v2 error (${resp.status}): ${msg}`);
            }
            const data = await resp.json();
            // v2 returns { items: [...] } (observed), but support other shapes defensively
            const items = Array.isArray(data?.items)
                ? data.items
                : (Array.isArray(data?.data)
                    ? data.data
                    : (Array.isArray(data?.campaigns)
                        ? data.campaigns
                        : (Array.isArray(data) ? data : [])));
            if (Array.isArray(items) && items.length > 0) {
                const sample = items[0];
                console.log('[campaigns] v2 sample keys', Object.keys(sample || {}));
            }
            return items;
        }
        try {
            let items = [];
            try {
                items = await fetchInstantlyCampaignsV2(instantlyKey);
            } catch (e2) {
                console.warn('Instantly v2 failed:', e2?.message || e2);
                // Do not fallback to v1 since route may be deprecated; surface error
                throw e2;
            }
            console.log('[campaigns] fetched items', { count: Array.isArray(items) ? items.length : 0 });
            campaigns = items.filter(c => {
                const createdRaw = c.timestamp_created || c.createdAt || c.created_at || c.created || c.created_at_utc || null;
                const created = createdRaw ? new Date(createdRaw) : null;
                return created && created instanceof Date && !isNaN(created.getTime()) && created >= since;
            });
            console.log('[campaigns] filtered items (lastNd)', { count: campaigns.length });
        } catch (err) {
            console.error('Instantly fetch campaigns error:', err?.message);
            return res.status(502).json({ error: 'Failed to fetch campaigns from Instantly.' });
        }

        // Upsert campaigns into subcollection
        const colRef = clientRef.collection('campaigns');
        const batch = firestore.batch();
        campaigns.forEach((c) => {
            const id = (c.id || c.campaignId || c.uuid || c._id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).toString();
            const ref = colRef.doc(id);
            const created = c.timestamp_created || c.createdAt || c.created_at || c.created || c.created_at_utc || null;
            batch.set(ref, {
                id,
                name: c.name || c.title || c.campaign_name || '',
                status: typeof c.status !== 'undefined' ? c.status : (c.state || ''),
                createdAt: created ? new Date(created).toISOString() : null,
                raw: c,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        });
        await batch.commit();
        console.log('[campaigns] upsert complete', { uid, clientId, wrote: campaigns.length });

        // Update client doc with active campaigns count (status === 1)
        try {
            const activeCount = campaigns.filter(c => {
                const statusVal = typeof c.status !== 'undefined' ? c.status : (c.state || null);
                return Number(statusVal) === 1;
            }).length;
            await clientRef.set({
                activeCampaigns: activeCount,
                campaignsLastSynced: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            console.log('[campaigns] client activeCampaigns updated', { clientId, activeCount });
        } catch (e) {
            console.warn('[campaigns] failed to set activeCampaigns', e?.message || e);
        }

        // Return count
        res.json({ count: campaigns.length });
    } catch (error) {
        console.error('Client campaigns sync error:', error);
        res.status(500).json({ error: 'Failed to sync campaigns.' });
    }
});

// Upload completed job results to Instantly campaign
app.post('/api/jobs/:id/upload-to-instantly', async (req, res) => {
    try {
        const { idToken, clientId, campaignId, columnMapping } = req.body || {};
        const jobId = req.params.id;

        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!campaignId) return res.status(400).json({ error: 'Missing campaign ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });
        if (!columnMapping) return res.status(400).json({ error: 'Missing column mapping.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        // Get the job or resolve paths from jobId
        let job = jobs.get(jobId);
        const jobDir = job?.paths?.dir || path.join(TMP_ROOT, jobId);
        const finalPath = job?.paths?.final || path.join(jobDir, 'final.csv');
        const personalizedPath = job?.paths?.personalized || path.join(jobDir, 'personalized.csv');

        if (!fs.existsSync(finalPath)) return res.status(404).json({ error: 'Result file missing' });

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

        // Read final.csv (verification results)
        const finalContent = fs.readFileSync(finalPath, 'utf-8');
        const finalRows = [];
        await new Promise((resolve, reject) => {
            const parser = csvParse({ columns: true, skip_empty_lines: true });
            parser.on('data', (row) => finalRows.push(row));
            parser.on('end', resolve);
            parser.on('error', reject);
            parser.write(finalContent);
            parser.end();
        });

        // Read personalized.csv if available and merge personalization fields by domain
        let personalizedByDomain = new Map();
        if (fs.existsSync(personalizedPath)) {
            const personalizedContent = fs.readFileSync(personalizedPath, 'utf-8');
            await new Promise((resolve, reject) => {
                const parser = csvParse({ columns: true, skip_empty_lines: true });
                parser.on('data', (row) => {
                    const domainKey = String(row.domain || '').toLowerCase();
                    if (domainKey) personalizedByDomain.set(domainKey, row);
                });
                parser.on('end', resolve);
                parser.on('error', reject);
                parser.write(personalizedContent);
                parser.end();
            });
        }

        // Build unified rows with derived first_name, last_name and personalization fields
        const records = finalRows.map(r => {
            const domainKey = String(r.domain || '').toLowerCase();
            const founder = String(r.founder_name || '').trim();
            const parts = founder.split(/\s+/);
            const first_name = parts[0] || '';
            const last_name = parts.length > 1 ? parts.slice(1).join(' ') : '';
            const personal = personalizedByDomain.get(domainKey) || {};
            return {
                domain: r.domain || '',
                email: r.email || '',
                email_status: r.email_status || r.lookup_status || '',
                first_name,
                last_name,
                personalization: personal.first_line || personal.personalization_first_line || '',
                product_title: personal.title || personal.personalization_title || ''
            };
        });

        // Filter for verified emails only (include valid-risky)
        const verified = records.filter(r => r.email_status === 'valid' || r.email_status === 'verified' || r.email_status === 'valid-risky');

        if (verified.length === 0) {
            return res.json({ count: 0, message: 'No verified emails to upload' });
        }

        // Upload to Instantly in batches
        const batchSize = 100;
        let uploaded = 0;
        let authFailed = false;

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
                        authFailed = true;
                        return res.status(401).json({ error: 'ERR_AUTH_FAILED', message: 'Instantly v2 authentication failed. Check API key and permissions.' });
                    }
                    throw new Error(`Instantly v2 API error: ${status}`);
                }

                // Successfully uploaded this batch
                uploaded += leads.length;
                console.log(`Successfully uploaded batch ${i / batchSize + 1}: ${leads.length} leads (total: ${uploaded}/${verified.length})`);
            } catch (error) {
                console.error('Error uploading batch to Instantly v2:', error);
                if (authFailed) return; // response already sent
                // Continue with other batches on non-auth errors
            }
        }

        res.json({ count: uploaded, total: verified.length });
    } catch (error) {
        console.error('Upload to Instantly error:', error);
        res.status(500).json({ error: 'Failed to upload to Instantly.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
