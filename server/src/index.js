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

const VALID_UPLOAD_STATUSES = new Set(['valid', 'verified', 'valid-risky']);

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

const DEFAULT_PRICING = {
    stages: {
        founders: {
            serper_request_cost: 0.001,
            openai_per_million_input: 0.25,
            openai_per_million_output: 2.0
        },
        emailDiscovery: { request_cost: 0 },
        verification: { request_cost: 0 },
        personalization: {
            openai_per_million_input: 0.25,
            openai_per_million_output: 2.0
        }
    },
    currency: 'USD'
};

const uploadFields = upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'idToken', maxCount: 1 },
    { name: 'clientId', maxCount: 1 },
    { name: 'nicheId', maxCount: 1 },
    { name: 'nicheLabel', maxCount: 1 },
    { name: 'skipFounderFinder', maxCount: 1 }
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

        const unified = await buildUnifiedRows(jobId, 'valid');
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

function closeStreams(job) {
    job.streams.forEach(stream => {
        try {
            stream.end();
        } catch {
            /* noop */
        }
    });
    job.streams = [];
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
        cost: typeof job.cost === 'number' ? job.cost : 0,
        fileName: job.fileName
    };
    broadcast(job, { type: 'state', state });
    persistJobState(job).catch(() => {
        /* already handled */
    });
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
    } else if (message) {
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

async function persistJobState(job) {
    if (!job?.uid || !job?.clientId) {
        return;
    }
    try {
        const jobRef = firestore
            .collection('users').doc(job.uid)
            .collection('clients').doc(job.clientId)
            .collection('jobs').doc(job.id);

        const payload = {
            ...serializeJob(job),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (!job.__persistedOnce) {
            await jobRef.set({
                ...payload,
                createdAtServer: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            job.__persistedOnce = true;
        } else {
            await jobRef.set(payload, { merge: true });
        }
    } catch (error) {
        console.error(`[${job?.id || 'unknown'}] Job persistence error:`, error?.message || error);
    }
}

async function loadPricing(uid) {
    let pricing = { ...DEFAULT_PRICING };
    try {
        // Try user-level override first
        if (uid) {
            const userPricingRef = firestore.collection('users').doc(uid).collection('config').doc('pricing');
            const snap = await userPricingRef.get();
            if (snap.exists) {
                pricing = { ...pricing, ...snap.data() };
            }
        }
        // Root-level default
        const rootPricingRef = firestore.collection('config').doc('pricing');
        const rootSnap = await rootPricingRef.get();
        if (rootSnap.exists) {
            pricing = { ...pricing, ...rootSnap.data() };
        }
    } catch (err) {
        console.warn('Pricing load failed, using defaults:', err?.message || err);
    }

    // Ensure nested stage defaults exist
    pricing.stages = pricing.stages || {};
    pricing.stages.founders = pricing.stages.founders || DEFAULT_PRICING.stages.founders;
    pricing.stages.emailDiscovery = pricing.stages.emailDiscovery || DEFAULT_PRICING.stages.emailDiscovery;
    pricing.stages.verification = pricing.stages.verification || DEFAULT_PRICING.stages.verification;
    pricing.stages.personalization = pricing.stages.personalization || DEFAULT_PRICING.stages.personalization;
    return pricing;
}

function computeJobCost(job) {
    const stageKeys = Object.keys(job.stages || {});
    const total = stageKeys.reduce((sum, key) => {
        const stage = job.stages[key];
        const fromSummary = stage?.summary && typeof stage.summary.cost === 'number' ? stage.summary.cost : 0;
        const fromProgress = stage?.progress && typeof stage.progress.cost === 'number' ? stage.progress.cost : 0;
        return sum + (fromSummary || fromProgress || 0);
    }, 0);
    job.cost = Number((total || 0).toFixed(6));
    return job.cost;
}

function createJobRecord(fileBuffer, originalName, apiKeys, uid, clientId, dedupeStrategy = 'skip', options = {}) {
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
        cancelled: false,
        skipFounderFinder: options.skipFounderFinder || false,
        findFounder: options.findFounder !== false,
        cost: 0,
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
            personalized: path.join(dir, 'personalized.csv'),
            upload: path.join(dir, 'upload.csv')
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
        const safeSummary = summary || {};
        updateStage(job, stageKey, { status: 'completed', completedAt: new Date().toISOString(), summary: safeSummary });
        return summary;
    } catch (err) {
        const message = err?.message || 'Unknown error';
        updateStage(job, stageKey, { status: 'error', completedAt: new Date().toISOString(), error: message });
        throw err;
    }
}

function markCancelled(job, reason = 'Cancelled by user') {
    job.cancelled = true;
    job.status = 'cancelled';
    job.error = reason;
    job.completedAt = job.completedAt || new Date().toISOString();
    pushState(job);
    closeStreams(job);
}

async function readCsvToArray(filePath) {
    const rows = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(filePath)
            .pipe(csvParse({ columns: true, skip_empty_lines: true, trim: true }))
            .on('data', (row) => rows.push(row))
            .on('end', resolve)
            .on('error', reject);
    });
    return rows;
}

function resolveJobPaths(jobId) {
    const job = jobs.get(jobId);
    const jobDir = job?.paths?.dir || path.join(TMP_ROOT, jobId);
    return {
        job,
        jobDir,
        finalPath: job?.paths?.final || path.join(jobDir, 'final.csv'),
        personalizedPath: job?.paths?.personalized || path.join(jobDir, 'personalized.csv'),
        uploadPath: job?.paths?.upload || path.join(jobDir, 'upload.csv')
    };
}

async function buildFoundersCsvFromInput({ filteredDomainsPath, originalInputPath, outputPath }) {
    const domainSet = new Set();
    await new Promise((resolve, reject) => {
        fs.createReadStream(filteredDomainsPath)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', row => {
                const domain = String(row.domain || '').toLowerCase();
                if (domain) domainSet.add(domain);
            })
            .on('end', resolve)
            .on('error', reject);
    });

    const domainToFounder = new Map();
    await new Promise((resolve, reject) => {
        fs.createReadStream(originalInputPath)
            .pipe(csvParse({ columns: true, trim: true }))
            .on('data', row => {
                const domain = String(row.domain || '').toLowerCase();
                const founder = String(row.founder_name || row.founder || '').trim();
                if (domain) domainToFounder.set(domain, founder);
            })
            .on('end', resolve)
            .on('error', reject);
    });

    const writer = fs.createWriteStream(outputPath);
    writer.write('domain,founder_name\n');
    domainSet.forEach(domain => {
        const name = (domainToFounder.get(domain) || '').replace(/"/g, '""');
        writer.write(`${domain},"${name}"\n`);
    });
    writer.end();
    await new Promise(resolve => writer.on('finish', resolve));
}

async function buildUnifiedRows(jobId, scope = 'all') {
    const { finalPath, personalizedPath } = resolveJobPaths(jobId);
    if (!fs.existsSync(finalPath)) {
        return [];
    }

    const finalRows = await readCsvToArray(finalPath);

    const personalizedByDomain = new Map();
    if (fs.existsSync(personalizedPath)) {
        const personalizedRows = await readCsvToArray(personalizedPath);
        personalizedRows.forEach((row) => {
            const domainKey = String(row.domain || '').toLowerCase();
            if (domainKey) personalizedByDomain.set(domainKey, row);
        });
    }

    const unified = finalRows.map((r) => {
        const domainKey = String(r.domain || '').toLowerCase();
        const founder = String(r.founder_name || '').trim();
        const parts = founder.split(/\s+/);
        const first_name = parts[0] || '';
        const last_name = parts.length > 1 ? parts.slice(1).join(' ') : '';
        const personal = personalizedByDomain.get(domainKey) || {};
        return {
            domain: r.domain || '',
            founder_name: r.founder_name || '',
            email: r.email || '',
            email_status: r.email_status || r.lookup_status || '',
            first_name,
            last_name,
            personalization: personal.first_line || personal.personalization_first_line || '',
            personalization_first_line: personal.first_line || personal.personalization_first_line || '',
            personalization_title: personal.title || personal.personalization_title || '',
            personalization_url: personal.url || personal.personalization_url || '',
            product_title: personal.title || personal.personalization_title || ''
        };
    });

    if (scope === 'valid') {
        return unified.filter(r => VALID_UPLOAD_STATUSES.has((r.email_status || '').toLowerCase()));
    }

    return unified;
}

async function writeUploadCsv(filePath, rows) {
    if (!rows || !Array.isArray(rows)) return;
    const headers = ['domain', 'founder_name', 'email', 'email_status', 'first_name', 'last_name', 'personalization', 'personalization_first_line', 'personalization_title', 'personalization_url', 'product_title'];
    const writer = fs.createWriteStream(filePath);
    writer.write(headers.join(',') + '\n');
    rows.forEach((row) => {
        const line = headers.map((key) => {
            const value = row[key] ?? '';
            const safe = String(value).replace(/"/g, '""');
            return `"${safe}"`;
        }).join(',');
        writer.write(line + '\n');
    });
    writer.end();
    await new Promise(resolve => writer.on('finish', resolve));
}

async function attachCampaignToLeads({ uid, clientId, campaignId, rows }) {
    if (!uid || !clientId || !campaignId || !Array.isArray(rows) || rows.length === 0) return;
    const leadsCol = firestore.collection('users').doc(uid).collection('clients').doc(clientId).collection('leads');
    const writer = firestore.bulkWriter();
    writer.onWriteError((error) => {
        const willRetry = error?.failedAttempts < 3;
        return willRetry;
    });

    rows.forEach((row) => {
        const domain = String(row.domain || '').toLowerCase();
        if (!domain) return;
        const ref = leadsCol.doc(domain);
        writer.set(ref, {
            campaignId,
            campaigns: admin.firestore.FieldValue.arrayUnion(campaignId),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    });

    await writer.close();
}

async function incrementCampaignLeadCount({ uid, clientId, campaignId, delta }) {
    if (!uid || !clientId || !campaignId || !Number.isFinite(delta) || delta <= 0) return;
    const campaignRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId).collection('campaigns').doc(campaignId);
    await campaignRef.set({
        totalLeads: admin.firestore.FieldValue.increment(delta),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

async function processJob(job) {
    job.status = 'running';
    pushState(job);
    log(job, 'Job started.');

    try {
        // Load pricing configuration
        try {
            job.pricing = await loadPricing(job.uid);
        } catch (err) {
            console.warn(`[${job.id}] Pricing load warning:`, err?.message || err);
            job.pricing = DEFAULT_PRICING;
        }

        if (job.cancelled) {
            markCancelled(job, 'Cancelled before start');
            return;
        }

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
            try {
                fs.writeFileSync(job.paths.final, 'domain,email,email_status,founder_name\n');
            } catch (err) {
                console.warn(`[${job.id}] Failed to write placeholder final.csv`, err?.message || err);
            }
            try {
                fs.writeFileSync(job.paths.personalized, 'domain,url,title,description,date,first_line\n');
            } catch (err) {
                console.warn(`[${job.id}] Failed to write placeholder personalized.csv`, err?.message || err);
            }
            try {
                fs.writeFileSync(job.paths.upload, 'domain,founder_name,email,email_status,first_name,last_name,personalization,personalization_first_line,personalization_title,personalization_url,product_title\n');
            } catch (err) {
                console.warn(`[${job.id}] Failed to write placeholder upload.csv`, err?.message || err);
            }

            Object.entries(job.stages).forEach(([stageKey, stage]) => {
                job.stages[stageKey] = {
                    ...stage,
                    status: 'completed',
                    startedAt: stage.startedAt || new Date().toISOString(),
                    completedAt: new Date().toISOString(),
                    summary: {
                        skipped: job.dedupeStats?.skipped || job.dedupeStats?.total || 0,
                        processed: 0
                    },
                    error: null,
                    progress: {
                        stage: stageKey,
                        processed: 0,
                        total: job.dedupeStats?.total || 0
                    }
                };
            });

            job.status = 'completed';
            job.completedAt = new Date().toISOString();
            pushState(job);
            log(job, 'Job completed: All domains were already processed (duplicates)');
            return;
        }

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        if (job.skipFounderFinder) {
            try {
                await buildFoundersCsvFromInput({
                    filteredDomainsPath,
                    originalInputPath: job.paths.domains,
                    outputPath: job.paths.founders
                });
                const processed = job.dedupeStats?.total || 0;
                updateStage(job, 'founders', {
                    status: 'completed',
                    completedAt: new Date().toISOString(),
                    startedAt: job.stages.founders.startedAt || new Date().toISOString(),
                    summary: { processed, cost: 0, skipped: 0 },
                    progress: {
                        stage: 'founders',
                        processed,
                        total: processed,
                        stats: { processed, total: processed, cost: 0 }
                    }
                });
                log(job, `Founders skipped (CSV included founder_name). Processed ${processed} domains.`);
            } catch (err) {
                console.error(`[${job.id}] Failed to build founders CSV from input:`, err?.message || err);
                throw err;
            }
        } else {
            await runStage(job, 'founders', () =>
                runFounderFinder({
                    inputCsv: filteredDomainsPath,
                    outputCsv: job.paths.founders,
                    apiKeys: job.apiKeys,
                    pricing: job.pricing?.stages?.founders || DEFAULT_PRICING.stages.founders,
                    log: (message, meta) => log(job, message, meta)
                })
            );
        }
        computeJobCost(job);

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        // Upsert leads with founder info
        await upsertLeadsFromCsv({ uid: job.uid, clientId: job.clientId, csvPath: job.paths.founders, type: 'founders', dedupeStrategy: job.dedupeStrategy });

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        await runStage(job, 'emailDiscovery', () =>
            runEmailFinder({
                inputCsv: job.paths.founders,
                outputCsv: job.paths.emails,
                apiKeys: job.apiKeys,
                log: (message, meta) => log(job, message, meta)
            })
        );
        computeJobCost(job);

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        // Upsert leads with email lookup results
        await upsertLeadsFromCsv({ uid: job.uid, clientId: job.clientId, csvPath: job.paths.emails, type: 'emails', dedupeStrategy: job.dedupeStrategy });

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        await runStage(job, 'verification', () =>
            runEmailVerifier({
                inputCsv: job.paths.emails,
                outputCsv: job.paths.final,
                apiKeys: job.apiKeys,
                log: (message, meta) => log(job, message, meta)
            })
        );
        computeJobCost(job);

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        // Upsert leads with verification status
        await upsertLeadsFromCsv({ uid: job.uid, clientId: job.clientId, csvPath: job.paths.final, type: 'verification', dedupeStrategy: job.dedupeStrategy });

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        await runStage(job, 'personalization', () =>
            runPersonalization({
                inputCsv: job.paths.final,
                outputCsv: job.paths.personalized,
                apiKeys: job.apiKeys,
                log: (message, meta) => log(job, message, meta),
                removeB2B: process.env.PERSONALIZATION_FILTER_B2B !== 'false'
            })
        );
        computeJobCost(job);

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        // Upsert leads with personalization data
        await upsertLeadsFromCsv({ uid: job.uid, clientId: job.clientId, csvPath: job.paths.personalized, type: 'personalization', dedupeStrategy: job.dedupeStrategy });

        // Build upload-ready CSV (valid/verified/valid-risky only)
        try {
            const uploadRows = await buildUnifiedRows(job.id, 'valid');
            await writeUploadCsv(job.paths.upload, uploadRows);
            log(job, `Upload CSV ready at ${job.paths.upload} (${uploadRows.length} rows)`);
        } catch (err) {
            console.warn(`[${job.id}] Failed to build upload.csv`, err?.message || err);
        }

        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        pushState(job);
        log(job, `Job completed. Final CSV ready at ${job.paths.final}`);
    } catch (err) {
        if (job.cancelled) {
            markCancelled(job, 'Cancelled during processing');
            return;
        }
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
        clientId: job.clientId,
        cost: typeof job.cost === 'number' ? job.cost : 0
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
        const rawSkipFounder = String(req.body.skipFounderFinder || '').toLowerCase() === 'true';
        const rawFindFounder = String(req.body.findFounder ?? 'true').toLowerCase() !== 'false';
        const skipFounderFinder = rawSkipFounder || !rawFindFounder;
        const job = createJobRecord(file.buffer, file.originalname, apiKeys, uid, clientId, dedupeStrategy, { skipFounderFinder, findFounder: rawFindFounder });
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

// Stop a running job
app.post('/api/jobs/:id/stop', async (req, res) => {
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

app.get('/api/jobs/:id/result', async (req, res) => {
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
        const rows = await buildUnifiedRows(jobId, scopeParam);
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
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csvLines.join('\n'));
    } catch (error) {
        console.error('Result download error:', error);
        res.status(500).json({ error: 'Failed to build export.' });
    }
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

        const verified = await buildUnifiedRows(jobId, 'valid');

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

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
