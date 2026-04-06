/**
 * Jobs API endpoints (Pipeline orchestration)
 *
 * CANONICAL AGENCY IDENTIFIER RULE:
 * The Firestore users/{uid} document ID is the canonical agency identifier.
 * This same Firebase Auth uid is used directly as agency_id in all PostgreSQL tables.
 * No reconciliation or mapping is required.
 *
 * This route manages:
 * 1. Firestore orchestration (job state, status, client metadata)
 * 2. CSV file uploads and processing
 * 3. Integration with PostgreSQL via the leads service (see services/leads.js)
 *
 * All PostgreSQL operations are scoped by agency_id derived from the verified Firebase token.
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
import { ensureJobControl, readJobControl, writeJobControl } from '../services/jobControl.js';
import { deleteQueueJob, enqueuePipelineJob, getQueueJob, setQueueStatus, updateQueueControl } from '../services/jobQueue.js';
import OpenAI from 'openai';

const router = express.Router();
const JOB_EXECUTION_MODE = String(process.env.JOB_EXECUTION_MODE || 'inline').toLowerCase();
const USE_QUEUE_EXECUTION = JOB_EXECUTION_MODE === 'queue';
const PERSONALIZATION_FIRST_LINE_PROMPT = ({ domain, productList, variantNumber }) => `You are analyzing multiple products from a Shopify store (domain: ${domain}).

Your task:
1. Review all products below.
2. Choose the ONE product most likely to be:
   - currently live and available
   - a real consumer product, not a test item, gift card, SKU dump, placeholder, or broken title
   - representative of the store
3. Generate one personalized first line based only on that chosen product.

First-line rules:
- Exact structure: "I was taking a look at the {natural product name} and {brief, specific observation}!"
- One sentence only
- Sound like one real person writing to one real person
- Keep it short, natural, and believable
- Prefer about 12 to 20 words total
- Use active voice
- The line must not imply I bought, used, touched, smelled, wore, tasted, or tried the product
- Base the observation only on things that could reasonably be noticed from the product title, description, or images
- The sentence must be grammatically complete and natural, with no missing words

Product name rules:
- Shorten the product name so it sounds natural in a cold opener
- Prefer the simplest natural version that still clearly identifies the product
- Do not invent, merge, rename, or alter key words from the original product name
- If shortening creates ambiguity or changes meaning, keep the clearer original words
- Drop promo words such as "NEW", "EXCLUSIVE", "BESTSELLER", "LIMITED", "FREE", "SALE"
- Drop bundle language, pack-size language, and extra descriptors unless essential
- Drop brand prefixes or sub-brands unless they help the name sound more natural
- Rewrite into normal sentence case when needed
- Use normal sentence case in the final line, not title case
- Prefer roughly 2 to 6 words for the product name inside the first line

Observation rules:
- The observation must read like a compliment, not a catalog description
- The observation must be a complete natural-language phrase, not a fragment
- The observation must include a natural verb such as "looks", "has", or "catches the light"
- Use only one concrete visual observation
- Prefer one specific visual anchor, such as:
  - a color
  - a print or pattern
  - a finish
  - a shape
  - packaging design
  - a visible material detail
  - one obvious visual contrast or standout element
- Prefer a specific detail over a broad adjective
- Prefer observations phrased with "looks" or "catches the light" over "it has"
- The compliment should sound casually human, not like a product review, merchandiser note, or catalog line
- If several possible compliments are similar, choose the one that sounds most distinctive and least generic
- Use "catches the light" only for surfaces where that would sound natural, such as metal, gloss, glass, polished finishes, or jewelry

Avoid:
- "We were taking a look"
- sentence fragments like "a hand-polished wire frame"
- copied product attributes pasted as compliments
- all-caps product names or robotic title casing
- altered names that do not clearly match the original title
- repeating descriptive words from the title unless they become a natural visual observation
- feature/spec descriptions such as pack size, number of pieces, included items, material composition, measurements, or construction details
- neutral summaries like "it has X and Y"
- analytic or merchandiser phrasing like "compact format", "tablet form", "neatly arranged", "individual sachets", "lineup", or "themed packaging"
- phrases like "in the photos", "on the page", or "in the images"
- repetitive default phrasing across outputs, especially "catches the eye" or "really stands out"
- any wording that implies physical experience, such as "feels", "smells", "tastes", "fits", "wears", "holds", or "in your hand"
- functional claims
- overly polished wording like "richly saturated", "delightfully playful", "playfully wild", or "perfectly toasted"
- marketing language, clichés, hype, or jargon
- generic praise like "craftsmanship really stands out", "high quality", "game changer", "amazing value"
- weak adjectives like "beautiful", "nice", "lovely", "inviting", "pretty", "amazing", "adorable", or "stunning" unless tied to one specific visual detail
- made-up personal scenarios
- mentioning friends, family, partners, roommates, gifts, workouts, hikes, weekends, or lifestyle assumptions
- recency phrasing like "launched recently" or "earlier this summer" unless clearly essential to the title
- multiple observations in one line

If the product list is mostly junk, duplicate filler, test products, gift cards, SKUs, or unusable titles, return: "invalid"

Products to choose from:
${productList}

Output format (JSON):
{
  "first_line": "..."
}`;

function stripHtmlForPrompt(html = '') {
    return String(html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeShopifyDomain(input = '') {
    const raw = String(input || '').trim().toLowerCase();
    if (!raw) return '';
    const withoutProtocol = raw.replace(/^https?:\/\//, '');
    return withoutProtocol.replace(/^www\./, '').split('/')[0].split('?')[0];
}

async function fetchShopifyProductList(domain, limit = 20) {
    const normalizedDomain = normalizeShopifyDomain(domain);
    if (!normalizedDomain) {
        throw new Error('Invalid domain.');
    }

    const response = await fetch(`https://${normalizedDomain}/products.json?limit=${limit}`);
    if (!response.ok) {
        throw new Error(`Failed to fetch products.json (HTTP ${response.status}).`);
    }

    const payload = await response.json();
    const products = Array.isArray(payload?.products) ? payload.products : [];
    if (!products.length) {
        throw new Error('No Shopify products returned for this domain.');
    }

    const lines = products.map((product, index) => {
        const title = String(product?.title || '').trim() || '[No title]';
        const bodyText = stripHtmlForPrompt(product?.body_html || '').slice(0, 300);
        const tags = String(product?.tags || '').trim();
        const status = String(product?.status || '').trim() || 'unknown';
        const publishedAt = String(product?.published_at || '').trim() || 'N/A';
        const variantCount = Array.isArray(product?.variants) ? product.variants.length : 0;

        return `${index + 1}. Title: ${title}
Description: ${bodyText || 'N/A'}
Tags: ${tags || 'N/A'}
Status: ${status}
Published At: ${publishedAt}
Variants: ${variantCount}`;
    });

    return {
        normalizedDomain,
        productCount: products.length,
        productList: lines.join('\n\n')
    };
}

function parseFirstLinesFromModelOutput(raw = '') {
    const text = String(raw || '').trim();
    if (!text) return null;

    const fencedMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = (fencedMatch ? fencedMatch[1] : text).trim();

    try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) {
            const values = parsed
                .filter((item) => typeof item === 'string')
                .map((item) => item.trim())
                .filter(Boolean);
            return values.length ? values : null;
        }
        if (typeof parsed === 'string') {
            const value = parsed.trim();
            return value ? [value] : null;
        }
        if (parsed && Array.isArray(parsed.first_lines)) {
            const values = parsed.first_lines
                .filter((item) => typeof item === 'string')
                .map((item) => item.trim())
                .filter(Boolean);
            return values.length ? values : null;
        }
        if (parsed && typeof parsed.first_line === 'string') {
            const value = parsed.first_line.trim();
            return value ? [value] : null;
        }
    } catch {
        // Fall through to non-JSON handling.
    }

    if (/^"?invalid"?$/i.test(candidate)) {
        return ['invalid'];
    }

    return null;
}

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
        productPromptVersion: job.productPromptVersion || 'old',
        productPromptProducts: Number.isFinite(job.productPromptProducts) ? job.productPromptProducts : 3,
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

function jobDocRef(uid, clientId, jobId) {
    return firestore
        .collection('users').doc(uid)
        .collection('clients').doc(clientId)
        .collection('jobs').doc(jobId);
}

async function getFirestoreOwnedJob({ jobId, uid, clientId }) {
    const ref = jobDocRef(uid, clientId, jobId);
    const snap = await ref.get();
    if (!snap.exists) {
        return { job: null, ref, exists: false };
    }
    return { job: snap.data() || {}, ref, exists: true };
}

async function loadApiKeys(uid) {
    const userDoc = await firestore.collection('users').doc(uid).get();
    if (!userDoc.exists) {
        throw new Error(`User not found for uid ${uid}`);
    }
    const data = userDoc.data() || {};
    return {
        openai: data.openai_key || '',
        serper: data.serper_key || '',
        kitt: data.trykitt_key || ''
    };
}

async function startInlineResumeJob({ jobId, uid, clientId, persistedJob }) {
    const jobDir = path.join(TMP_ROOT, jobId);
    const domainsPath = path.join(jobDir, 'domains.csv');
    if (!fs.existsSync(domainsPath)) {
        throw new Error(`Job input file missing for ${jobId}`);
    }

    const filteredPath = (persistedJob?.filteredPath && fs.existsSync(persistedJob.filteredPath))
        ? persistedJob.filteredPath
        : (fs.existsSync(path.join(jobDir, 'domains-filtered.csv'))
            ? path.join(jobDir, 'domains-filtered.csv')
            : null);

    const control = ensureJobControl(jobId, {
        paused: false,
        cancelled: false
    });
    const apiKeys = await loadApiKeys(uid);

    const runtimeJob = {
        id: jobId,
        status: 'queued',
        createdAt: persistedJob?.createdAt || new Date().toISOString(),
        completedAt: null,
        error: null,
        fileName: persistedJob?.fileName || 'domains.csv',
        apiKeys,
        uid,
        clientId,
        sqlClientId: persistedJob?.sqlClientId || null,
        dedupeStrategy: persistedJob?.dedupeStrategy || 'skip',
        cancelled: !!control.cancelled,
        paused: !!control.paused,
        skipFounderFinder: !!persistedJob?.skipFounderFinder,
        skipEmailFinder: !!persistedJob?.skipEmailFinder,
        skipVerification: !!persistedJob?.skipVerification,
        skipDomainCheck: !!persistedJob?.skipDomainCheck,
        findFounder: persistedJob?.findFounder !== false,
        industry: persistedJob?.industry || null,
        nicheId: persistedJob?.nicheId || null,
        nicheLabel: persistedJob?.nicheLabel || null,
        personalizeFirstLine: !!persistedJob?.personalizeFirstLine,
        productPromptVersion: persistedJob?.productPromptVersion || 'old',
        productPromptProducts: Number.isFinite(persistedJob?.productPromptProducts) ? persistedJob.productPromptProducts : 3,
        emailVerificationProvider: persistedJob?.emailVerificationProvider || 'trykitt',
        columnMapping: persistedJob?.columnMapping || { domain: 'domain', founder: '', email: '' },
        cost: typeof persistedJob?.cost === 'number' ? persistedJob.cost : 0,
        stages: buildStages(persistedJob?.stages || null),
        logs: [],
        streams: [],
        dedupeStats: persistedJob?.dedupeStats || null,
        __persistedOnce: true,
        paths: {
            dir: jobDir,
            tmpDir: jobDir,
            domains: domainsPath,
            filtered: filteredPath,
            founders: path.join(jobDir, 'founders.csv'),
            emails: path.join(jobDir, 'emails.csv'),
            final: path.join(jobDir, 'final.csv'),
            personalized: path.join(jobDir, 'personalized.csv'),
            upload: path.join(jobDir, 'upload.csv')
        }
    };

    jobs.set(runtimeJob.id, runtimeJob);
    setImmediate(() => {
        processJob(runtimeJob)
            .catch((err) => {
                console.error(`[${runtimeJob.id}] Inline resumed job execution failed:`, err?.message || err);
            })
            .finally(() => {
                closeStreams(runtimeJob);
                jobs.delete(runtimeJob.id);
            });
    });

    return runtimeJob;
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
    { name: 'productPromptVersion', maxCount: 1 },
    { name: 'productPromptProducts', maxCount: 1 },
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
        const productPromptVersionRaw = (req.body.productPromptVersion || '').toString().trim().toLowerCase();
        const productPromptVersion = productPromptVersionRaw === 'new_gpt5mini' ? 'new_gpt5mini' : 'old';
        const productPromptProductsParsed = parseInt(req.body.productPromptProducts || '3', 10);
        const productPromptProducts = Number.isFinite(productPromptProductsParsed)
            ? Math.max(1, Math.min(productPromptProductsParsed, 5))
            : 3;
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
            productPromptVersion,
            productPromptProducts,
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
        let persistedJob = null;
        let persistedJobRef = null;
        if (!localJob) {
            const ownership = await verifyQueuedJobOwnership({ jobId, uid, clientId });
            if (ownership.error) {
                if (ownership.error === 'Unauthorized.') {
                    return res.status(403).json({ error: 'Unauthorized to stop this job.' });
                }
                const persisted = await getFirestoreOwnedJob({ jobId, uid, clientId });
                if (!persisted.exists) {
                    return res.status(404).json({ error: 'Job not found.' });
                }
                persistedJob = persisted.job;
                persistedJobRef = persisted.ref;
            } else {
                queueJob = ownership.queueJob;
            }
        } else {
            queueJob = await getQueueJob(jobId);
        }

        if (queueJob?.status === 'completed') {
            return res.json({ status: 'completed', message: 'Job already completed.' });
        }
        if (queueJob?.status === 'cancelled') {
            return res.json({ status: 'cancelled', message: 'Job already cancelled.' });
        }
        if (persistedJob?.status === 'completed') {
            return res.json({ status: 'completed', message: 'Job already completed.' });
        }
        if (persistedJob?.status === 'cancelled') {
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

        if (!localJob && !queueJob && persistedJobRef) {
            await persistedJobRef.set({
                status: 'cancelled',
                cancelled: true,
                paused: false,
                error: 'Cancelled by user',
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
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

        if (!localJob && !queueJob) {
            return res.json({
                status: 'cleaned',
                message: 'Job runner was not active. Stale run reference cleared.'
            });
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
        let persistedJob = null;
        let persistedJobRef = null;
        if (!localJob) {
            const ownership = await verifyQueuedJobOwnership({ jobId, uid, clientId });
            if (ownership.error) {
                if (ownership.error === 'Unauthorized.') {
                    return res.status(403).json({ error: 'Unauthorized to pause this job.' });
                }
                const persisted = await getFirestoreOwnedJob({ jobId, uid, clientId });
                if (!persisted.exists) {
                    return res.status(404).json({ error: 'Job not found.' });
                }
                persistedJob = persisted.job;
                persistedJobRef = persisted.ref;
            } else {
                queueJob = ownership.queueJob;
            }
        } else {
            queueJob = await getQueueJob(jobId);
        }

        if (queueJob?.status === 'cancelled') {
            return res.json({ status: 'cancelled', message: 'Job is cancelled, cannot pause.' });
        }
        if (persistedJob?.status === 'cancelled') {
            return res.json({ status: 'cancelled', message: 'Job is cancelled, cannot pause.' });
        }
        if (persistedJob?.status === 'completed') {
            return res.json({ status: 'completed', message: 'Job already completed.' });
        }
        if (queueJob?.status === 'paused' || queueJob?.control?.paused || localJob?.paused || persistedJob?.paused) {
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
        if (!localJob && !queueJob && persistedJobRef) {
            await persistedJobRef.set({
                status: 'paused',
                paused: true,
                pausedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
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
        let persistedJob = null;
        let persistedJobRef = null;
        if (!localJob) {
            const ownership = await verifyQueuedJobOwnership({ jobId, uid, clientId });
            if (ownership.error) {
                if (ownership.error === 'Unauthorized.') {
                    return res.status(403).json({ error: 'Unauthorized to resume this job.' });
                }
                const persisted = await getFirestoreOwnedJob({ jobId, uid, clientId });
                if (!persisted.exists) {
                    return res.status(404).json({ error: 'Job not found.' });
                }
                persistedJob = persisted.job;
                persistedJobRef = persisted.ref;
            } else {
                queueJob = ownership.queueJob;
            }
        } else {
            queueJob = await getQueueJob(jobId);
        }

        if (queueJob?.status === 'cancelled') {
            return res.json({ status: 'cancelled', message: 'Job is cancelled, cannot resume.' });
        }
        if (persistedJob?.status === 'cancelled') {
            return res.json({ status: 'cancelled', message: 'Job is cancelled, cannot resume.' });
        }
        if (persistedJob?.status === 'completed') {
            return res.json({ status: 'completed', message: 'Job already completed.' });
        }

        const control = readJobControl(jobId);
        const queuePaused = queueJob?.status === 'paused' || !!queueJob?.control?.paused;
        const persistedPaused = persistedJob?.status === 'paused' || !!persistedJob?.paused;
        const localPaused = !!localJob?.paused;
        const isPaused = queuePaused || persistedPaused || localPaused || !!control?.paused;
        if (!isPaused) {
            const fallbackStatus = queueJob?.status || localJob?.status || persistedJob?.status || 'unknown';
            return res.json({ status: fallbackStatus, message: 'Job is not paused.' });
        }

        writeJobControl(jobId, { paused: false, cancelled: false });
        if (queueJob) {
            await updateQueueControl(jobId, { paused: false, cancelled: false });
        }
        if (queueJob?.status === 'paused') {
            await setQueueStatus(jobId, 'queued', { error: null });
        }

        if (localJob && localJob.uid === uid && localJob.clientId === clientId) {
            markResumed(localJob);
        }

        let resumedStatus = queueJob?.status === 'running'
            ? 'running'
            : (localJob ? 'running' : 'queued');

        if (!localJob && !queueJob) {
            if (USE_QUEUE_EXECUTION) {
                const inferredFilteredPath = path.join(TMP_ROOT, jobId, 'domains-filtered.csv');
                const payload = {
                    id: jobId,
                    fileName: persistedJob?.fileName || 'domains.csv',
                    createdAt: persistedJob?.createdAt || new Date().toISOString(),
                    dedupeStrategy: persistedJob?.dedupeStrategy || 'skip',
                    sqlClientId: persistedJob?.sqlClientId || null,
                    skipFounderFinder: !!persistedJob?.skipFounderFinder,
                    skipEmailFinder: !!persistedJob?.skipEmailFinder,
                    skipVerification: !!persistedJob?.skipVerification,
                    skipDomainCheck: !!persistedJob?.skipDomainCheck,
                    findFounder: persistedJob?.findFounder !== false,
                    industry: persistedJob?.industry || null,
                    nicheId: persistedJob?.nicheId || null,
                    nicheLabel: persistedJob?.nicheLabel || null,
                    personalizeFirstLine: !!persistedJob?.personalizeFirstLine,
                    productPromptVersion: persistedJob?.productPromptVersion || 'old',
                    productPromptProducts: Number.isFinite(persistedJob?.productPromptProducts) ? persistedJob.productPromptProducts : 3,
                    emailVerificationProvider: persistedJob?.emailVerificationProvider || 'trykitt',
                    columnMapping: persistedJob?.columnMapping || { domain: 'domain', founder: '', email: '' },
                    dedupeStats: persistedJob?.dedupeStats || null,
                    cost: typeof persistedJob?.cost === 'number' ? persistedJob.cost : 0,
                    stages: persistedJob?.stages || null,
                    filteredPath: (persistedJob?.filteredPath && fs.existsSync(persistedJob.filteredPath))
                        ? persistedJob.filteredPath
                        : (fs.existsSync(inferredFilteredPath) ? inferredFilteredPath : null)
                };

                await enqueuePipelineJob({
                    jobId,
                    uid,
                    clientId,
                    payload
                });
                await updateQueueControl(jobId, { paused: false, cancelled: false });
                await setQueueStatus(jobId, 'queued', { error: null });
                resumedStatus = 'queued';
            } else {
                await startInlineResumeJob({
                    jobId,
                    uid,
                    clientId,
                    persistedJob
                });
                resumedStatus = 'running';
            }
        }

        if (persistedJobRef) {
            await persistedJobRef.set({
                status: resumedStatus,
                paused: false,
                resumedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        }

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
                                    const offset = idx * 4;
                                    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
                                }).join(', ');
                                
                                const params = contactsResult.rows.flatMap(contact => [
                                    contact.id,
                                    sqlCampaignId,
                                    jobId,
                                    'pipeline'
                                ]);
                                
                                await pool.query(
                                    `INSERT INTO contact_instantly_campaigns 
                                        (contact_id, campaign_id, job_id, upload_source)
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

// Test endpoint for iterating on personalization prompts.
// Replace PERSONALIZATION_TEST_PROMPT above with your hardcoded prompt as needed.
router.get('/jobs/personalizer/test-prompt', async (req, res) => {
    try {
        const authHeader = req.headers.authorization || '';
        const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
        const idToken = (req.query?.idToken || bearerToken || '').toString().trim();
        let openaiKey = '';

        if (idToken) {
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            const uid = decodedToken.uid;

            const userDoc = await firestore.collection('users').doc(uid).get();
            if (userDoc.exists) {
                openaiKey = (userDoc.data()?.openai_key || '').toString().trim();
            }
        }

        if (!openaiKey) {
            openaiKey = (process.env.OPENAI_API_KEY || '').toString().trim();
        }

        if (!openaiKey) {
            return res.status(400).json({
                error: 'Missing OpenAI key. Set OPENAI_API_KEY in server env, or pass a valid Firebase token for user vault lookup.'
            });
        }

        const domain = (req.query?.domain || '').toString().trim();
        const productListFromQuery = (req.query?.productList || '').toString().trim();
        const productsLimitRaw = parseInt((req.query?.productsLimit || '20').toString(), 10);
        const productsLimit = Number.isFinite(productsLimitRaw)
            ? Math.max(1, Math.min(productsLimitRaw, 100))
            : 20;
        const model = (req.query?.model || 'gpt-5-mini').toString().trim();

        if (!domain) {
            return res.status(400).json({ error: 'Missing required query param: domain.' });
        }

        let productList = productListFromQuery;
        let productsFetched = 0;
        let normalizedDomain = normalizeShopifyDomain(domain);
        if (!productList) {
            const fetched = await fetchShopifyProductList(domain, productsLimit);
            productList = fetched.productList;
            productsFetched = fetched.productCount;
            normalizedDomain = fetched.normalizedDomain;
        }

        const openai = new OpenAI({ apiKey: openaiKey });
        const variationPromises = Array.from({ length: 5 }, (_, index) => {
            const prompt = PERSONALIZATION_FIRST_LINE_PROMPT({
                domain: normalizedDomain || domain,
                productList,
                variantNumber: index + 1
            });

            return openai.chat.completions.create({
                model,
                messages: [{ role: 'user', content: prompt }]
            });
        });

        const variationCompletions = await Promise.all(variationPromises);
        const firstLines = variationCompletions.map((completion) => {
            const output = completion.choices?.[0]?.message?.content?.trim() || '';
            const parsed = parseFirstLinesFromModelOutput(output);
            return parsed?.[0] || null;
        });

        const validFirstLines = firstLines.filter((line) => typeof line === 'string' && line !== 'invalid');
        if (validFirstLines.length === 0) {
            return res.json({ first_lines: ['invalid'] });
        }

        if (validFirstLines.length < 5) {
            return res.status(502).json({ error: 'Model returned fewer than 5 valid first lines.' });
        }

        return res.json({ first_lines: validFirstLines.slice(0, 5) });
    } catch (error) {
        console.error('Personalization test-prompt error:', error);
        return res.status(500).json({ error: 'Failed to run personalization test prompt.' });
    }
});

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
