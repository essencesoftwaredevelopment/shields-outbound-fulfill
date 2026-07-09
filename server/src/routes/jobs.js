/**
 * Jobs API endpoints (Pipeline orchestration)
 *
 * Jobs API — pipeline orchestration backed by PostgreSQL (jobs, job_queue, contacts).
 * agency_id is the legacy tenant id resolved from Supabase Auth via agency_auth_map.
 */

import express from 'express';
import multer from 'multer';
import fs from 'fs';
import {
    buildUnifiedRowsFromDb,
    listUnifiedRowsFromDb,
    countUnifiedRowsByEmailStatus,
    filterUnifiedRowsByEmailStatus,
    getUnifiedRowHeaders,
    isShoppingAuditJobById,
    shoppingAuditFromJobRow,
    getJobById,
    jobHasRemainingPipelineWork,
    jobRowToState,
    setActiveJob,
    updateJobControl,
    updateActiveJobStatus,
    listJobsForClient,
    getActiveJobForClient,
    deleteJobFromDb,
    clearActiveJobForClient,
} from '../services/db/jobs.js';
import { getAgencySettings, apiKeysFromSettings, hasShoppingAuditFeature } from '../services/db/agencySettings.js';
import { resolveAgencyId } from '../utils/bearerAuth.js';
import { agencyFromRequest, clientContextFromRequest } from '../utils/requestContext.js';
import { writeJobControl } from '../services/jobControl.js';
import { TMP_ROOT } from '../config/paths.js';
import { resolveJobPaths } from '../services/jobPipeline.js';
import { attachCampaignToLeads, incrementCampaignLeadCount } from '../services/leads.js';
import { createJobRecord, jobs, logJob, markCancelled, markPaused, markResumed, serializeJob } from '../services/jobPipeline.js';
import { getOrCreateClient, getClientRowBySlug, resolveClientRow } from '../services/db/queries.js';
import { pool } from '../config/db.js';
import { runPersonalizerPipeline } from '../services/personalizerPipeline.js';
import path from 'path';
import { deleteQueueJob, enqueuePipelineJob, getQueueJob, getRunnerRecord, setQueueStatus, updateQueueControl } from '../services/jobQueue.js';
import { dispatchEnrichmentJob } from '../enrichment/dispatch.js';
import { clearWorkflowRunId } from '../enrichment/persist.js';
import { resolveExecutionRunner } from '../enrichment/executionRunner.js';
import { queryFilteredLeadSeedRows } from './leads.js';

async function enrichJobWithQueueRuntime(jobState, jobId) {
    if (!jobState || !jobId) return jobState;
    const row = await getRunnerRecord(jobId);
    if (!row) {
        return { ...jobState, queueStatus: null, workerActive: false };
    }
    const workerActive = row.runner_pid != null && row.status === 'running';
    const queueStatus = jobState.paused && row.status === 'running' ? 'paused' : row.status;
    return {
        ...jobState,
        queueStatus,
        workerActive
    };
}
import { forceTerminateRunner } from '../services/jobRunner.js';
import { normalizeDomain } from '../utils/domain.js';
import OpenAI from 'openai';

const router = express.Router();
const personalizerStatusById = new Map();

function readPersonalizerStatus(jobId) {
    const cached = personalizerStatusById.get(jobId);
    if (cached) return cached;
    const statusPath = path.join(TMP_ROOT, 'jobs', jobId, 'status.json');
    if (!fs.existsSync(statusPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    } catch {
        return null;
    }
}

function writePersonalizerStatus(jobId, patch) {
    const base = readPersonalizerStatus(jobId) || {
        id: jobId,
        status: 'running',
        stages: {
            shopifyDetection: { status: 'pending' },
            klaviyoDetection: { status: 'pending' },
            productFetch: { status: 'pending' },
            personalization: { status: 'pending' }
        },
        result: null,
        error: null
    };
    const next = {
        ...base,
        ...patch,
        stages: { ...base.stages, ...(patch.stages || {}) },
        updatedAt: new Date().toISOString()
    };
    personalizerStatusById.set(jobId, next);
    const statusPath = path.join(TMP_ROOT, 'jobs', jobId, 'status.json');
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    fs.writeFileSync(statusPath, JSON.stringify(next));
    return next;
}

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
        pipelineMode: job.pipelineMode || 'standard',
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
        filteredPath: job.paths?.filtered || null,
        // Omit default — dispatchEnrichmentJob resolves runner from env/agency via resolveExecutionRunner.
        ...(job.executionRunner || job.options?.executionRunner
            ? { executionRunner: job.executionRunner || job.options.executionRunner }
            : {})
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

async function loadApiKeys(uid) {
    const settings = await getAgencySettings(uid);
    if (!settings) {
        throw new Error(`Agency settings not found for ${uid}`);
    }
    const keys = apiKeysFromSettings(settings);
    keys.kitt = settings.trykitt_key || '';
    return keys;
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
        const { clientId, emailStatusInclude } = req.body || {};
        const includeValid = emailStatusInclude?.includeValid !== false;
        const includeRisky = emailStatusInclude?.includeRisky !== false;
        const jobId = req.params.id;

        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });
        if (!includeValid && !includeRisky) {
            return res.status(400).json({ error: 'Select at least one email status to preview.' });
        }

        await agencyFromRequest(req);

        const allEligible = await buildUnifiedRowsFromDb(jobId, 'valid', { includeValid: true, includeRisky: true });
        if (!allEligible.length) {
            return res.status(404).json({ error: 'No verified leads available for upload.' });
        }

        const emailStatusCounts = countUnifiedRowsByEmailStatus(allEligible);
        const unified = filterUnifiedRowsByEmailStatus(allEligible, { includeValid, includeRisky });
        if (!unified.length) {
            return res.status(404).json({ error: 'No leads match the selected email statuses.' });
        }

        const allKeys = new Set();
        unified.forEach((row) => Object.keys(row).forEach((k) => allKeys.add(k)));
        const headers = Array.from(allKeys);
        const previewRows = unified.slice(0, 100);

        res.json({
            headers,
            previewRows,
            emailStatusCounts,
            uploadTotal: unified.length
        });
    } catch (error) {
        console.error('CSV preview error:', error);
        res.status(500).json({ error: 'Failed to load CSV preview.' });
    }
});

router.get('/jobs/:id/leads-preview', async (req, res) => {
    try {
        const jobId = req.params.id;
        const clientSlug = (req.query.clientId || '').toString().trim();
        const scopeParam = (req.query.scope || 'all').toString();
        const scope = scopeParam === 'valid' ? 'valid' : 'all';
        const limit = req.query.limit;
        const offset = req.query.offset;

        if (!clientSlug) {
            return res.status(400).json({ error: 'clientId parameter is required' });
        }

        const agencyId = await agencyFromRequest(req);
        const row = await getJobById(jobId, agencyId);
        if (!row) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const includeValid = req.query.includeValid !== 'false';
        const includeRisky = req.query.includeRisky !== 'false';
        const options = scope === 'valid' ? { includeValid, includeRisky } : {};
        const shoppingAudit = shoppingAuditFromJobRow(row);
        const result = await listUnifiedRowsFromDb(jobId, {
            scope,
            limit,
            offset,
            shoppingAudit,
            sortByCompleteness: true,
            ...options
        });

        res.json(result);
    } catch (error) {
        console.error('Job leads preview error:', error);
        res.status(500).json({ error: 'Failed to load job leads preview.' });
    }
});

/** Max domains a filtered-leads job may seed (fat-finger guard; filters are the real cap). */
const LEAD_FILTER_JOB_MAX_DOMAINS = 200000;

function sanitizeLeadFilterInput(rawLeadFilter) {
    if (!rawLeadFilter || typeof rawLeadFilter !== 'object' || Array.isArray(rawLeadFilter)) return null;
    const search = typeof rawLeadFilter.search === 'string' ? rawLeadFilter.search.trim() : '';
    const instantlyCampaignId = typeof rawLeadFilter.instantlyCampaignId === 'string'
        ? rawLeadFilter.instantlyCampaignId.trim()
        : '';
    const filters = rawLeadFilter.filters && typeof rawLeadFilter.filters === 'object'
        ? rawLeadFilter.filters
        : undefined;
    const parsedRowLimit = Number.parseInt(rawLeadFilter.rowLimit, 10);
    const rowLimit = Number.isInteger(parsedRowLimit) && parsedRowLimit > 0 ? parsedRowLimit : null;
    return {
        ...(search ? { search } : {}),
        ...(instantlyCampaignId ? { instantlyCampaignId } : {}),
        ...(filters ? { filters } : {}),
        ...(rowLimit ? { rowLimit } : {})
    };
}

router.post('/jobs', uploadFields, async (req, res) => {
    try {
        const hasFile = Boolean(req.files?.file && req.files.file[0]);
        const leadFilter = hasFile ? null : sanitizeLeadFilterInput(req.body?.leadFilter);
        if (!hasFile && !leadFilter) {
            return res.status(400).json({ error: 'Missing CSV file upload.' });
        }

        const uid = await agencyFromRequest(req);
        const settings = await getAgencySettings(uid);
        const apiKeys = apiKeysFromSettings(settings);
        apiKeys.kitt = settings?.trykitt_key || '';
        const emailVerificationProvider = settings?.email_verification_provider || 'trykitt';

        if (!apiKeys.openai || !apiKeys.serper) {
            return res.status(400).json({ error: 'Missing required API keys (OpenAI, Serper) in agency settings.' });
        }
        if (emailVerificationProvider === 'trykitt' && !apiKeys.kitt) {
            return res.status(400).json({ error: 'Missing Kitt API key for TryKitt provider.' });
        }

        const file = hasFile ? req.files.file[0] : null;
        const clientSlug = (req.body.clientId || '').toString().trim();
        const sqlClientId = await getOrCreateClient(uid, clientSlug);

        // Filtered-leads jobs re-process rows that by definition already exist;
        // 'skip' would silently no-op the entire job.
        const dedupeStrategy = leadFilter ? 'include' : (req.body.dedupeStrategy || 'skip').toString();
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
        if (emailVerificationProvider === 'self_hosted') skipVerification = true;
        const skipEmailFinder = String(req.body.skipEmailFinder || '').toLowerCase() === 'true';
        const skipDomainCheck = String(req.body.skipDomainCheck || '').toLowerCase() === 'true';
        const pipelineModeRaw = String(req.body.pipelineMode || 'standard').trim().toLowerCase();
        const pipelineMode = pipelineModeRaw === 'shopping_audit' ? 'shopping_audit' : 'standard';
        if (pipelineMode === 'shopping_audit' && !hasShoppingAuditFeature(settings)) {
            return res.status(403).json({ error: 'Shopping audit pipeline is not enabled for this agency.' });
        }

        let seedEntries = null;
        let jobFileName = file?.originalname || null;
        if (leadFilter) {
            const seedRows = await queryFilteredLeadSeedRows(uid, sqlClientId, leadFilter, {
                rowLimit: Math.min(leadFilter.rowLimit || LEAD_FILTER_JOB_MAX_DOMAINS, LEAD_FILTER_JOB_MAX_DOMAINS)
            });
            if (!seedRows.length) {
                return res.status(400).json({ error: 'No leads match the current filter.' });
            }
            // raw_row carries existing values for visibility/debugging, but the
            // column mapping deliberately leaves founder/email unmapped: a mapped
            // column with an empty value flags the row founderExcluded /
            // out-of-cohort (see computeCohortMeta), which would silently drop
            // every lead missing that value. Stage toggles + 'include' queues
            // already scope re-runs correctly.
            seedEntries = seedRows.map((row) => ({
                domain: row.domain,
                raw: {
                    domain: row.domain,
                    founder_name: row.full_name || '',
                    email: row.email || ''
                }
            }));
            jobFileName = `Filtered leads (${seedEntries.length.toLocaleString('en-US')} domains)`;
        }

        const job = await createJobRecord(file?.buffer || null, jobFileName, apiKeys, uid, clientSlug, dedupeStrategy, {
            skipFounderFinder,
            skipEmailFinder,
            skipVerification,
            skipDomainCheck,
            findFounder: rawFindFounder,
            industry: pipelineMode === 'shopping_audit' ? 'shopping_audit' : industry,
            nicheId: pipelineMode === 'shopping_audit' ? 'shopping_audit' : nicheId,
            nicheLabel: pipelineMode === 'shopping_audit' ? (nicheLabel || 'Shopping Audit') : nicheLabel,
            personalizeFirstLine,
            productPromptVersion,
            productPromptProducts,
            emailVerificationProvider,
            pipelineMode,
            sqlClientId,
            ...(seedEntries
                ? {
                    domainEntries: seedEntries,
                    jobSource: 'lead_filter',
                    leadFilter,
                    columnMapping: { domain: 'domain', founder: '', email: '' }
                }
                : {
                    columnMapping: {
                        domain: (req.body.domainColumn || 'domain').toString().trim(),
                        founder: (req.body.founderColumn || '').toString().trim(),
                        email: (req.body.emailColumn || '').toString().trim()
                    }
                })
        });

        await setActiveJob(job.id, uid, sqlClientId);
        await updateJobControl(job.id, { paused: false, cancelled: false });
        logJob(job, `Job queued with file ${job.fileName}`);

        const queuePayload = buildQueuePayload(job);
        await dispatchEnrichmentJob({
            jobId: job.id,
            uid,
            clientId: job.clientId,
            payload: queuePayload,
            settings
        });
        jobs.delete(job.id);

        res.status(201).json({ jobId: job.id, job: serializeJob(job) });
    } catch (error) {
        console.error('Job creation error:', error);
        res.status(500).json({ error: error?.message || 'Failed to create job.' });
    }
});

router.get('/jobs/:id', async (req, res) => {
    try {
        const jobId = req.params.id;
        const memoryJob = jobs.get(jobId);
        if (memoryJob) {
            const job = await enrichJobWithQueueRuntime(serializeJob(memoryJob), jobId);
            return res.json({ job });
        }

        const agencyId = await agencyFromRequest(req);
        const row = await getJobById(jobId, agencyId);
        if (!row) {
            return res.status(404).json({ error: 'Job not found' });
        }
        const job = await enrichJobWithQueueRuntime(jobRowToState(row), jobId);
        return res.json({ job });
    } catch (error) {
        console.error('GET job error:', error);
        res.status(500).json({ error: 'Failed to load job' });
    }
});

router.get('/jobs', async (req, res) => {
    try {
        const clientSlug = req.query.clientId;
        if (!clientSlug) {
            return res.status(400).json({ error: 'clientId required' });
        }
        const { agencyId, sqlClientId } = await clientContextFromRequest(req, clientSlug);
        const rows = await listJobsForClient(agencyId, sqlClientId);
        res.json({ jobs: rows.map(jobRowToState) });
    } catch (error) {
        console.error('LIST jobs error:', error);
        res.status(500).json({ error: 'Failed to list jobs' });
    }
});

router.post('/clients/:clientId/active-job/discard', async (req, res) => {
    try {
        const { agencyId, sqlClientId } = await clientContextFromRequest(req, req.params.clientId);
        const row = await getActiveJobForClient(agencyId, sqlClientId);
        if (row) {
            await clearActiveJobForClient(agencyId, sqlClientId, { jobId: row.id, uploadStatus: 'discarded' });
            await pool.query(
                `UPDATE jobs SET status = 'discarded', upload_status = 'discarded', is_active = false, updated_at = NOW()
                 WHERE id = $1 AND agency_id = $2`,
                [row.id, agencyId]
            );
        }
        res.json({ ok: true });
    } catch (error) {
        const status = error.statusCode || 500;
        res.status(status).json({ error: error.message || 'Failed to discard active job.' });
    }
});

router.get('/clients/:clientId/active-job', async (req, res) => {
    try {
        const { agencyId, sqlClientId } = await clientContextFromRequest(req, req.params.clientId);
        const row = await getActiveJobForClient(agencyId, sqlClientId);
        res.json({
            activeJob: row
                ? {
                    jobId: row.id,
                    status: row.status,
                    upload_status: row.upload_status,
                    upload_error: row.upload_error,
                    upload_metrics: row.upload_metrics
                }
                : null
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to load active job' });
    }
});

// Stop a running job
router.post('/jobs/:id/stop', async (req, res) => {
    try {
        const jobId = req.params.id;
        const { clientId } = req.body || {};
        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });

        const { agencyId, sqlClientId, row } = await clientContextFromRequest(req, clientId);
        const dbRow = await getJobById(jobId, agencyId);
        if (!dbRow || dbRow.client_slug !== (row?.slug || clientId)) {
            return res.status(404).json({ error: 'Job not found.' });
        }

        const localJob = jobs.get(jobId);
        if (localJob && (localJob.uid !== agencyId || localJob.clientId !== clientId)) {
            return res.status(403).json({ error: 'Unauthorized to stop this job.' });
        }

        const queueJob = await getQueueJob(jobId);
        if (queueJob && (queueJob.uid !== agencyId || queueJob.clientId !== clientId)) {
            return res.status(403).json({ error: 'Unauthorized to stop this job.' });
        }

        if (dbRow.status === 'completed') {
            return res.json({ status: 'completed', message: 'Job already completed.' });
        }
        if (dbRow.cancelled || dbRow.status === 'cancelled') {
            return res.json({ status: 'cancelled', message: 'Job already cancelled.' });
        }

        writeJobControl(jobId, { cancelled: true, paused: false });
        await updateJobControl(jobId, { cancelled: true, paused: false });
        if (queueJob) {
            await updateQueueControl(jobId, { cancelled: true, paused: false });
            if (['queued', 'paused', 'running'].includes(queueJob.status)) {
                await setQueueStatus(jobId, 'cancelled', { error: 'Cancelled by user' });
            }
        }

        void forceTerminateRunner(jobId).catch((err) => {
            console.error(`[${jobId}] Force terminate after stop:`, err?.message || err);
        });

        if (localJob && localJob.uid === agencyId && localJob.clientId === clientId) {
            localJob.cancelled = true;
            await markCancelled(localJob, 'Cancelled by user');
        }

        await clearActiveJobForClient(agencyId, sqlClientId, { jobId, uploadStatus: 'cancelled' });
        await pool.query(
            `UPDATE jobs SET status = 'cancelled', cancelled = true, paused = false,
                error = 'Cancelled by user', completed_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND agency_id = $2`,
            [jobId, agencyId]
        );

        if (!localJob && !queueJob) {
            return res.json({
                status: 'cleaned',
                message: 'Job runner was not active. Stale run reference cleared.'
            });
        }

        return res.json({ status: 'cancelled' });
    } catch (error) {
        console.error('Stop job error:', error);
        const status = error.statusCode || 500;
        return res.status(status).json({ error: error.message || 'Failed to cancel job.' });
    }
});

router.post('/jobs/:id/pause', async (req, res) => {
    try {
        const jobId = req.params.id;
        const agencyId = await agencyFromRequest(req);

        const row = await getJobById(jobId, agencyId);
        if (!row) return res.status(404).json({ error: 'Job not found.' });

        writeJobControl(jobId, { paused: true, cancelled: false });
        await updateJobControl(jobId, { paused: true, cancelled: false });
        await clearWorkflowRunId(jobId);
        const queueJob = await getQueueJob(jobId);
        if (queueJob) {
            await updateQueueControl(jobId, { paused: true });
            if (queueJob.status === 'queued' || queueJob.status === 'running') {
                await setQueueStatus(jobId, 'paused');
            }
        }

        const localJob = jobs.get(jobId);
        if (localJob) await markPaused(localJob, 'Paused by user');

        return res.json({ status: 'paused' });
    } catch (error) {
        console.error('Pause job error:', error);
        return res.status(500).json({ error: 'Failed to pause job.' });
    }
});

router.post('/jobs/:id/resume', async (req, res) => {
    try {
        const jobId = req.params.id;
        const clientId = (req.body?.clientId || req.query?.clientId || '').toString().trim();
        if (!jobId || !clientId) {
            return res.status(400).json({ error: 'Missing job ID or client ID.' });
        }

        const uid = await resolveAgencyId(req);
        const row = await getJobById(jobId, uid);
        if (!row || row.client_slug !== clientId) {
            return res.status(404).json({ error: 'Job not found.' });
        }
        const queueJob = await getQueueJob(jobId);
        const stages = row.stages && typeof row.stages === 'object' ? row.stages : {};
        const emailDiscoveryIncomplete = stages.emailDiscovery?.status !== 'completed';
        const pipelineHadStarted = ['domainPrep', 'founders', 'emailDiscovery'].some(
            (key) => stages[key]?.status === 'completed' || stages[key]?.status === 'running' || stages[key]?.status === 'error'
        );
        const recoverablePauseCancel = row.cancelled && emailDiscoveryIncomplete && pipelineHadStarted
            && (row.paused || queueJob?.status === 'paused' || queueJob?.status === 'cancelled');

        // Recover jobs that were paused but incorrectly marked cancelled (pre-fix email finder stop)
        if (recoverablePauseCancel) {
            writeJobControl(jobId, { paused: true, cancelled: false });
            await updateJobControl(jobId, { paused: true, cancelled: false });
            if (queueJob) {
                await updateQueueControl(jobId, { paused: true, cancelled: false });
                if (queueJob.status === 'cancelled' || queueJob.status === 'failed') {
                    await setQueueStatus(jobId, 'paused', { error: null });
                }
            }
            row.cancelled = false;
            row.paused = true;
        } else if (row.cancelled) {
            return res.json({ status: 'cancelled', message: 'Job is cancelled, cannot resume.' });
        }

        const options = row.options || {};
        const remainingWork = await jobHasRemainingPipelineWork({
            agencyId: uid,
            clientId: row.client_id,
            jobId,
            skipVerification: !!options.skipVerification,
            personalizeFirstLine: !!options.personalizeFirstLine,
            dedupeStrategy: options.dedupeStrategy || 'skip',
            jobStartedAt: row.created_at ? new Date(row.created_at).toISOString() : null
        });
        const settings = await getAgencySettings(uid);
        const runner = resolveExecutionRunner({ settings, jobOptions: options });
        const stuckVercelWorkflow =
            runner === 'vercel'
            && row.status === 'running'
            && !row.cancelled
            && !row.paused
            && !!options.workflowRunId
            && remainingWork;

        const recoveryResume = row.status === 'completed' && remainingWork;

        if (row.status === 'completed' && !recoveryResume) {
            return res.json({ status: 'completed', message: 'Job already completed.' });
        }
        if (!row.paused && !recoveryResume && !stuckVercelWorkflow) {
            return res.json({ status: row.status, message: 'Job is not paused.' });
        }

        if (recoveryResume) {
            await pool.query(
                `UPDATE jobs SET status = 'queued', completed_at = NULL, paused = true, updated_at = NOW() WHERE id = $1`,
                [jobId]
            );
            row.status = 'queued';
            row.paused = true;
            if (queueJob) {
                await setQueueStatus(jobId, 'paused', { error: null });
            }
        } else if (stuckVercelWorkflow) {
            await clearWorkflowRunId(jobId);
            await pool.query(
                `UPDATE jobs SET error = NULL, updated_at = NOW() WHERE id = $1`,
                [jobId]
            );
            row.error = null;
        }

        const localJob = jobs.get(jobId);

        if (localJob) {
            await markResumed(localJob);
        }

        writeJobControl(jobId, { paused: false, cancelled: false });
        await updateJobControl(jobId, { paused: false, cancelled: false });
        if (queueJob) {
            await updateQueueControl(jobId, { paused: false, cancelled: false });
            if (queueJob.status === 'paused') {
                await setQueueStatus(jobId, 'queued', { error: null });
            }
        }

        const payload = buildQueuePayload(jobRowToState(row));
        await dispatchEnrichmentJob({
            jobId,
            uid,
            clientId,
            payload,
            settings
        });
        if (runner === 'pm2') {
            await setQueueStatus(jobId, 'queued', { error: null });
        }
        const resumedStatus = runner === 'vercel' ? 'running' : 'queued';

        await pool.query(
            `UPDATE jobs SET status = $2, paused = false, resumed_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [jobId, resumedStatus]
        );
        await setActiveJob(jobId, uid, row.client_id);

        return res.json({ status: resumedStatus });
    } catch (error) {
        console.error('Resume job error:', error);
        const status = error.statusCode || 500;
        return res.status(status).json({ error: error.message || 'Failed to resume job.' });
    }
});

// Delete a job (remove files, memory state, and Firestore record)
router.post('/jobs/:id/delete', async (req, res) => {
    try {
        const jobId = req.params.id;
        const { clientId } = req.body || {};
        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });

        const { agencyId, sqlClientId } = await clientContextFromRequest(req, clientId);
        const dbRow = await getJobById(jobId, agencyId);
        if (!dbRow || dbRow.client_slug !== clientId) {
            return res.status(404).json({ error: 'Job not found.' });
        }

        const job = jobs.get(jobId);
        const queueJob = await getQueueJob(jobId);
        if (queueJob && (queueJob.uid !== agencyId || queueJob.clientId !== clientId)) {
            return res.status(403).json({ error: 'Unauthorized to delete this job.' });
        }
        if (job && (job.uid !== agencyId || job.clientId !== clientId)) {
            return res.status(403).json({ error: 'Unauthorized to delete this job.' });
        }

        if (job) {
            if (!job.cancelled && job.status === 'running') {
                markCancelled(job, 'Deleted by user');
            }
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

        await clearActiveJobForClient(agencyId, sqlClientId, { jobId, uploadStatus: 'deleted' });
        await deleteJobFromDb(jobId, agencyId);

        return res.json({ status: 'deleted' });
    } catch (error) {
        console.error('Delete job error:', error);
        const status = error.statusCode || 500;
        return res.status(status).json({ error: error.message || 'Failed to delete job.' });
    }
});

router.get('/jobs/:id/result', async (req, res) => {
    const jobId = req.params.id;
    const scopeParam = (req.query?.scope || '').toString() === 'valid' ? 'valid' : 'all';

    try {
        const shoppingAudit = await isShoppingAuditJobById(jobId);
        const rows = await buildUnifiedRowsFromDb(
            jobId,
            scopeParam === 'valid' ? 'valid' : 'all',
            { shoppingAudit }
        );
        if (!rows.length) {
            return res.status(404).json({ error: 'No data to export.' });
        }
        const headers = getUnifiedRowHeaders(shoppingAudit);
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

router.post('/jobs/:id/upload-to-instantly', async (req, res) => {
    const jobId = req.params.id;
    let campaignIdParam = null;

    const recordUploadStatus = async (count, total) => {
        try {
            await updateActiveJobStatus(jobId, 'uploaded', {
                uploadMetrics: { count, total, campaignId: campaignIdParam || null },
                uploadError: null,
                status: 'uploaded'
            });
        } catch (err) {
            console.error('Failed to record upload status:', err);
        }
    };

    const recordUploadFailure = async (message) => {
        try {
            await updateActiveJobStatus(jobId, 'pending-upload', {
                uploadError: message,
                status: 'pending-upload'
            });
        } catch (err) {
            console.error('Failed to record upload failure:', err);
        }
    };

    try {
        const { idToken, clientId, campaignId, columnMapping, customVariables, skipOptions, emailStatusInclude } = req.body || {};
        const includeValid = emailStatusInclude?.includeValid !== false;
        const includeRisky = emailStatusInclude?.includeRisky !== false;
        campaignIdParam = campaignId;

        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!campaignId) return res.status(400).json({ error: 'Missing campaign ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });
        if (!columnMapping) return res.status(400).json({ error: 'Missing column mapping.' });
        if (!includeValid && !includeRisky) {
            return res.status(400).json({ error: 'Select at least one email status to upload.' });
        }

        const uid = await resolveAgencyId(req);

        const clientRow = await getClientRowBySlug(uid, clientId);
        if (!clientRow) {
            return res.status(404).json({ error: 'Client not found' });
        }
        const instantlyKey = clientRow.instantly_key || '';
        if (!instantlyKey) {
            return res.status(400).json({ error: 'Client has no Instantly API key configured' });
        }

        const verified = await buildUnifiedRowsFromDb(jobId, 'valid', { includeValid, includeRisky });

        if (verified.length === 0) {
            await recordUploadStatus(0, 0);
            return res.json({ count: 0, total: 0, message: 'No leads match the selected email statuses' });
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
        const { clientId, campaignId, notes } = req.body;

        if (!clientId) return res.status(400).json({ error: 'Missing client ID.' });
        if (!campaignId) return res.status(400).json({ error: 'Missing campaign ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });

        const uid = await agencyFromRequest(req);
        const clientRow = await resolveClientRow(uid, clientId);
        if (!clientRow) {
            return res.status(404).json({ error: 'Client not found in SQL.' });
        }
        const sqlClientId = clientRow.id;

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

// POST /api/jobs/batch/upload-status - Get upload status for multiple jobs
router.post('/jobs/batch/upload-status', async (req, res) => {
    try {
        const { jobIds, clientId } = req.body;

        if (!Array.isArray(jobIds) || jobIds.length === 0) {
            return res.status(400).json({ error: 'jobIds must be a non-empty array.' });
        }

        const clientSlug = String(clientId || '').trim();
        if (!clientSlug) {
            return res.status(400).json({ error: 'Missing clientId.' });
        }

        const agencyId = await agencyFromRequest(req);
        const clientRow = await resolveClientRow(agencyId, clientSlug);
        if (!clientRow) {
            return res.json({ statusMap: {} });
        }

        const sqlClientId = clientRow.id;

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
        const clientSlug = String(req.query.clientId || '').trim();

        if (!clientSlug) {
            return res.status(400).json({ error: 'Missing clientId query parameter.' });
        }

        const agencyId = await agencyFromRequest(req);
        const clientRow = await resolveClientRow(agencyId, clientSlug);
        if (!clientRow) {
            return res.json({ uploads: [] });
        }

        const sqlClientId = clientRow.id;

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
        const { campaignId } = req.body;

        if (!campaignId) return res.status(400).json({ error: 'Missing campaign ID.' });
        if (!jobId) return res.status(400).json({ error: 'Missing job ID.' });

        const uid = await agencyFromRequest(req);

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
        const { domains, clientId: clientSlug } = req.body;

        if (!Array.isArray(domains) || domains.length === 0) {
            return res.status(400).json({ error: 'domains must be a non-empty array.' });
        }

        if (!clientSlug) {
            return res.status(400).json({ error: 'Missing clientId.' });
        }

        const agencyId = await agencyFromRequest(req);

        const normalizedDomainsRaw = domains.map((d) => normalizeDomain(d)).filter(Boolean);
        const uniqueDomains = Array.from(new Set(normalizedDomainsRaw));

        const clientRow = await resolveClientRow(agencyId, String(clientSlug).trim());
        if (!clientRow?.id) {
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

        const sqlClientId = clientRow.id;

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
        let openaiKey = '';
        try {
            const agencyId = await agencyFromRequest(req);
            const keys = await loadApiKeys(agencyId);
            openaiKey = (keys.openai || '').toString().trim();
        } catch {
            openaiKey = '';
        }

        if (!openaiKey) {
            openaiKey = (process.env.OPENAI_API_KEY || '').toString().trim();
        }

        if (!openaiKey) {
            return res.status(400).json({
                error: 'Missing OpenAI key. Set OPENAI_API_KEY in server env, or sign in with agency vault keys configured.'
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

router.get('/jobs/personalizer/:jobId/status', async (req, res) => {
    try {
        const status = readPersonalizerStatus(req.params.jobId);
        if (!status) {
            return res.status(404).json({ error: 'Personalizer job not found.' });
        }
        return res.json({ job: status });
    } catch (error) {
        console.error('Personalizer status error:', error);
        return res.status(500).json({ error: 'Failed to load personalizer status.' });
    }
});

router.post('/jobs/personalizer', personalizerFields, async (req, res) => {
    try {
        if (!req.files?.file || !req.files.file[0]) {
            return res.status(400).json({ error: 'Missing CSV file upload.' });
        }

        const agencyId = await agencyFromRequest(req);
        const apiKeys = await loadApiKeys(agencyId);
        if (!apiKeys.openai) {
            return res.status(400).json({ error: 'Missing OpenAI API key in agency vault.' });
        }

        const file = req.files.file[0];
        const clientId = (req.body.clientId || '').toString().trim();
        const productsToPull = parseInt(req.body.productsToPull || '3', 10);
        const checkKlaviyo = String(req.body.checkKlaviyo || '').toLowerCase() === 'true';
        const removeB2B = String(req.body.removeB2B || '').toLowerCase() === 'true';

        const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const jobDir = path.join(TMP_ROOT, 'jobs', jobId);
        fs.mkdirSync(jobDir, { recursive: true });

        const inputCsv = path.join(jobDir, 'input.csv');
        const outputCsv = path.join(jobDir, 'personalized.csv');
        fs.writeFileSync(inputCsv, file.buffer);

        writePersonalizerStatus(jobId, {
            fileName: file.originalname,
            status: 'running',
            clientId,
            config: { productsToPull, checkKlaviyo, removeB2B }
        });

        const updateStage = async (stage, updates) => {
            const current = readPersonalizerStatus(jobId) || {};
            writePersonalizerStatus(jobId, {
                stages: {
                    ...(current.stages || {}),
                    [stage]: {
                        ...((current.stages || {})[stage] || {}),
                        ...updates,
                        ...(updates.startedAt ? { startedAt: new Date().toISOString() } : {}),
                        ...(updates.completedAt ? { completedAt: new Date().toISOString() } : {})
                    }
                }
            });
        };

        (async () => {
            try {
                await updateStage('shopifyDetection', { status: 'running', startedAt: true });

                const log = (message, meta) => {
                    console.log(`[${jobId}] ${message || ''}`);
                    if (meta?.progress?.stage) {
                        updateStage(meta.progress.stage, { progress: meta.progress }).catch(() => {});
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
                    jobRef: null,
                    updateStage
                });

                writePersonalizerStatus(jobId, {
                    status: 'completed',
                    completedAt: new Date().toISOString(),
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
                writePersonalizerStatus(jobId, {
                    status: 'failed',
                    error: error.message,
                    completedAt: new Date().toISOString()
                });
            }
        })();

        res.status(201).json({
            jobId,
            message: 'Personalizer job started'
        });
    } catch (error) {
        console.error('Personalizer job creation error:', error);
        const status = error.statusCode || 500;
        res.status(status).json({ error: error.message || 'Failed to create personalizer job.' });
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
