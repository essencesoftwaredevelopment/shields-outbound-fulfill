import fs from 'fs';
import path from 'path';
import { env } from '../config/env.js';
import { admin, firestore } from '../config/firebase.js';
import { TMP_ROOT } from '../config/paths.js';
import { DEFAULT_PRICING, loadPricing, computeJobCost } from '../utils/pricing.js';
import { buildFoundersCsvFromInput, buildEmailsCsvFromInput, buildUnifiedRows, writeUploadCsv } from '../utils/csv.js';
import { filterAndWriteProcessedDomains, upsertLeadsFromCsv, upsertLeadRowsBatch } from './leads.js';
import { runFounderFinder } from './founderFinder.js';
import { runEmailFinder } from './emailFinder.js';
import { runEmailVerifier } from './emailVerifier.js';
import { runPersonalization } from './personalization/index.js';
import { withTx, batchUpsertCompanies } from '../lib/db.js';
import { parse as csvParse } from 'csv-parse';

export const jobs = new Map();

// ============================================================================
// FIRESTORE WRITE THROTTLING
// ============================================================================
// To reduce Firestore costs and improve performance, we throttle persistence:
// - SSE broadcasts happen on EVERY update for real-time UI
// - Firestore writes happen every N leads (default: 5) or 2+ seconds apart
// - Status changes (completed, error, stage transitions) ALWAYS trigger writes
// - This reduces 10,000 writes/job → ~2,000 writes/job for large datasets
// ============================================================================

const FIRESTORE_UPDATE_INTERVAL = 5; // Update every N processed items
const FIRESTORE_MIN_INTERVAL_MS = 2000; // Minimum 2 seconds between updates
const REALTIME_STAGE_MIN_INTERVAL_MS = 500; // Faster updates for realtime stages (emailDiscovery, verification)

function shouldUpdateFirestore(job) {
    // Always update on status changes or completion
    if (job.__lastStatus !== job.status || job.status === 'completed' || job.status === 'failed') {
        job.__lastStatus = job.status;
        job.__lastFirestoreUpdate = Date.now();
        return true;
    }
    
    // For realtime stages (emailDiscovery, verification), use faster update interval
    const activeStage = Object.keys(job.stages).find(
        key => job.stages[key]?.status === 'running'
    );
    const isRealtimeStage = activeStage === 'emailDiscovery' || activeStage === 'verification';
    const minInterval = isRealtimeStage ? REALTIME_STAGE_MIN_INTERVAL_MS : FIRESTORE_MIN_INTERVAL_MS;
    
    // Throttle progress updates
    const now = Date.now();
    const timeSinceLastUpdate = now - (job.__lastFirestoreUpdate || 0);
    
    // Ensure minimum time interval
    if (timeSinceLastUpdate < minInterval) {
        return false;
    }
    
    // Check if we've processed enough items
    const currentCount = job.__updateCounter || 0;
    if (currentCount >= FIRESTORE_UPDATE_INTERVAL) {
        job.__updateCounter = 0;
        job.__lastFirestoreUpdate = now;
        return true;
    }
    
    return false;
}

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

function pushState(job, forceFirestoreUpdate = false) {
    const state = {
        id: job.id,
        status: job.status,
        stages: job.stages,
        error: job.error,
        paused: job.paused || false,
        pausedAt: job.pausedAt || null,
        resumedAt: job.resumedAt || null,
        cancelled: job.cancelled || false,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        clientId: job.clientId,
        dedupeStats: job.dedupeStats || null,
        cost: typeof job.cost === 'number' ? job.cost : 0,
        fileName: job.fileName
    };
    
    // Always broadcast to SSE streams for real-time updates
    broadcast(job, { type: 'state', state });
    
    // Throttle Firestore updates unless forced or criteria met
    if (forceFirestoreUpdate || shouldUpdateFirestore(job)) {
        persistJobState(job).catch(() => {
            /* already handled */
        });
    }
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
                ...rest,
                stage  // Preserve stage name so frontend can identify it
            }
        };
        
        // Increment update counter for throttling
        job.__updateCounter = (job.__updateCounter || 0) + 1;
        
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
    // Force Firestore update on stage transitions
    const forceUpdate = updates.status !== undefined;
    pushState(job, forceUpdate);
}

async function persistJobState(job) {
    if (!job?.uid || !job?.clientId) {
        console.error(`[${job?.id || 'unknown'}] Cannot persist: missing uid or clientId`, { uid: job?.uid, clientId: job?.clientId });
        return;
    }
    try {
        console.log(`[${job.id}] Persisting job state to Firestore...`);
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
            console.log(`[${job.id}] Job persisted to Firestore (first time)`);
        } else {
            await jobRef.set(payload, { merge: true });
            console.log(`[${job.id}] Job updated in Firestore`);
        }
    } catch (error) {
        console.error(`[${job?.id || 'unknown'}] Job persistence error:`, error?.message || error);
    }
}

async function updateActiveJob(job, status, additionalData = {}) {
    if (!job?.uid || !job?.clientId) {
        console.warn(`[${job?.id || 'unknown'}] Cannot update activeJob: missing uid (${job?.uid}) or clientId (${job?.clientId})`);
        return;
    }
    try {
        const activeJobRef = firestore
            .collection('users').doc(job.uid)
            .collection('clients').doc(job.clientId)
            .collection('activeJob').doc('current');

        console.log(`[${job.id}] Setting activeJob: users/${job.uid}/clients/${job.clientId}/activeJob/current`, { jobId: job.id, status, ...additionalData });
        await activeJobRef.set({
            jobId: job.id,
            status,
            ...additionalData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log(`[${job.id}] ActiveJob document updated successfully`);
    } catch (error) {
        console.error(`[${job?.id || 'unknown'}] Active job update error:`, error?.message || error);
    }
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
        
        // Check for credit exhaustion error
        if (err?.code === 'CREDIT_EXHAUSTED') {
            console.log(`[${job.id}] Credit exhausted at stage ${stageKey}, pausing job`);
            updateStage(job, stageKey, { status: 'error', error: 'Add Credits to TryKitt' });
            markPaused(job, 'Add Credits to TryKitt');
            // Throw a special error that processJob will catch and handle gracefully
            const pauseError = new Error('Job paused due to credit exhaustion');
            pauseError.code = 'JOB_PAUSED';
            throw pauseError;
        }
        
        updateStage(job, stageKey, { status: 'error', completedAt: new Date().toISOString(), error: message });
        throw err;
    }
}

function markCancelled(job, reason = 'Cancelled by user') {
    job.cancelled = true;
    job.status = 'failed';  // Cancelled jobs are treated as failed in primary status
    job.error = reason;
    job.completedAt = job.completedAt || new Date().toISOString();
    pushState(job);
    closeStreams(job);
}

function markPaused(job, reason = 'Paused by user') {
    job.paused = true;
    job.status = 'running';  // Paused jobs keep running status (can be resumed)
    job.pausedAt = new Date().toISOString();
    console.log(`[${job.id}] Job paused. paused=${job.paused}, status=${job.status}`);
    log(job, reason);
    pushState(job);
}

function markResumed(job) {
    job.paused = false;
    job.status = 'running';
    job.resumedAt = new Date().toISOString();
    log(job, 'Job resumed.');
    pushState(job);
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
        sqlClientId: options.sqlClientId || null,
        dedupeStrategy,
        cancelled: false,
        paused: false,
        skipFounderFinder: options.skipFounderFinder || false,
        skipEmailFinder: options.skipEmailFinder || false,
        skipVerification: options.skipVerification || false,
        findFounder: options.findFounder !== false,
        industry: options.industry || options.nicheId || null,
        nicheId: options.nicheId || null,
        nicheLabel: options.nicheLabel || null,
        personalizeFirstLine: options.personalizeFirstLine === true,
        emailVerificationProvider: options.emailVerificationProvider || 'trykitt',
        columnMapping: options.columnMapping || { domain: 'domain', founder: '', email: '' },
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
            tmpDir: dir,
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
                agencyId: job.uid,
                clientId: job.sqlClientId,
                jobId: job.id,
                domainsCsvPath: job.paths.domains,
                dedupeStrategy: job.dedupeStrategy,
                domainColumn: job.columnMapping?.domain || 'domain'
            });
            filteredDomainsPath = filtered;
            job.dedupeStats = dedupeStats;
            log(job, `Deduplication: ${dedupeStats.total} total, ${dedupeStats.skipped} skipped, ${dedupeStats.new} new domains to process`);
        }

        // Immediately upsert domains into SQL so the UI reflects new companies right after upload
        await upsertDomainsImmediately(job, filteredDomainsPath);

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
                fs.writeFileSync(job.paths.upload, 'domain,founder_name,email,email_status,first_name,last_name,personalization\n');
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
            await updateActiveJob(job, 'completed', { uploadError: null, uploadMetrics: null });
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
                    outputPath: job.paths.founders,
                    columnMapping: job.columnMapping
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
                    log: (message, meta) => log(job, message, meta),
                    checkpointDir: job.tmpDir
                })
            );
            // Upsert leads with founder info (only when actually found)
            await upsertLeadsFromCsv({ agencyId: job.uid, clientId: job.sqlClientId, csvPath: job.paths.founders, type: 'founders', jobId: job.id });
        }
        computeJobCost(job);

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        if (job.skipEmailFinder) {
            try {
                await buildEmailsCsvFromInput({
                    filteredDomainsPath,
                    originalInputPath: job.paths.domains,
                    outputPath: job.paths.emails,
                    columnMapping: job.columnMapping
                });
                const emailsContent = fs.readFileSync(job.paths.emails, 'utf-8');
                const lines = emailsContent.split('\n').filter(line => line.trim());
                const processed = Math.max(0, lines.length - 1);
                
                updateStage(job, 'emailDiscovery', {
                    status: 'completed',
                    completedAt: new Date().toISOString(),
                    startedAt: job.stages.emailDiscovery.startedAt || new Date().toISOString(),
                    summary: { processed, cost: 0, skipped: processed },
                    progress: {
                        stage: 'emailDiscovery',
                        processed,
                        total: processed,
                        stats: { processed, total: processed, cost: 0 }
                    }
                });
                log(job, `Email discovery skipped (CSV included email). Processed ${processed} rows.`);
            } catch (err) {
                console.error(`[${job.id}] Failed to build emails CSV from input:`, err?.message || err);
                throw err;
            }
        } else {
            await runStage(job, 'emailDiscovery', () =>
                runEmailFinder({
                    inputCsv: job.paths.founders,
                    outputCsv: job.paths.emails,
                    apiKeys: job.apiKeys,
                    provider: job.emailVerificationProvider,
                    log: (message, meta) => log(job, message, meta),
                    job,
                    checkPaused: () => job.paused,
                    onBatch: async (rows) => {
                        await upsertLeadRowsBatch({
                            agencyId: job.uid,
                            clientId: job.sqlClientId,
                            rows,
                            type: 'emails',
                            jobId: job.id
                        });
                    }
                })
            );
            // Upsert leads with email lookup results (only when actually found)
            await upsertLeadsFromCsv({ agencyId: job.uid, clientId: job.sqlClientId, csvPath: job.paths.emails, type: 'emails', jobId: job.id });
        }
        computeJobCost(job);

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        if (job.skipVerification) {
            try {
                // Copy emails.csv to final.csv without verification
                const emailsContent = fs.readFileSync(job.paths.emails, 'utf-8');
                fs.writeFileSync(job.paths.final, emailsContent);
                
                const lines = emailsContent.split('\n').filter(line => line.trim());
                const processed = Math.max(0, lines.length - 1); // Subtract header
                
                // Count email statuses from self-hosted finding (already verified)
                let valid = 0;
                let invalid = 0;
                let validRisky = 0;
                let unknown = 0;
                
                const rows = emailsContent.split('\n').slice(1); // Skip header
                for (const row of rows) {
                    if (!row.trim()) continue;
                    const parts = row.split(',');
                    // Status is in the last column (lookup_status or email_status)
                    const status = parts[parts.length - 1]?.replace(/^"|"$/g, '').trim().toLowerCase();
                    
                    if (status === 'valid') {
                        valid++;
                    } else if (status === 'invalid') {
                        invalid++;
                    } else if (status === 'valid-risky') {
                        validRisky++;
                    } else if (status && status !== 'not_found' && status !== 'not_processed') {
                        unknown++;
                    }
                }
                
                updateStage(job, 'verification', {
                    status: 'completed',
                    completedAt: new Date().toISOString(),
                    startedAt: job.stages.verification.startedAt || new Date().toISOString(),
                    summary: { 
                        processed, 
                        cost: 0, 
                        skipped: processed,
                        valid,
                        invalid,
                        'valid-risky': validRisky,
                        unknown
                    },
                    progress: {
                        stage: 'verification',
                        processed,
                        total: processed,
                        stats: { processed, total: processed, cost: 0, valid, invalid, 'valid-risky': validRisky, unknown }
                    }
                });
                log(job, `Verification skipped (self-hosted already verified). ${valid} valid, ${validRisky} valid-risky, ${invalid} invalid.`);
            } catch (err) {
                console.error(`[${job.id}] Failed to skip verification:`, err?.message || err);
                throw err;
            }
        } else {
            await runStage(job, 'verification', () =>
                runEmailVerifier({
                    inputCsv: job.paths.emails,
                    outputCsv: job.paths.final,
                    apiKeys: job.apiKeys,
                    provider: job.emailVerificationProvider,
                    log: (message, meta) => log(job, message, meta),
                    job,
                    checkPaused: () => job.paused
                })
            );
        }
        computeJobCost(job);

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        // Upsert leads with verification status
        await upsertLeadsFromCsv({ agencyId: job.uid, clientId: job.sqlClientId, csvPath: job.paths.final, type: 'verification', jobId: job.id });

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
                removeB2B: false, // Disabled B2B filtering
                industry: job.industry || job.nicheId || null,
                nicheId: job.nicheId || null,
                nicheLabel: job.nicheLabel || null,
                personalizeFirstLine: job.personalizeFirstLine,
            })
        );
        computeJobCost(job);

        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        // Upsert leads with personalization data
        await upsertLeadsFromCsv({ agencyId: job.uid, clientId: job.sqlClientId, csvPath: job.paths.personalized, type: 'personalization', jobId: job.id });

        // Build upload-ready CSV (complete leads with founder, email, and personalization)
        try {
            const uploadRows = await buildUnifiedRows({ jobId: job.id, scope: 'complete', resolveJobPaths });
            await writeUploadCsv(job.paths.upload, uploadRows);
            log(job, `Upload CSV ready at ${job.paths.upload} (${uploadRows.length} rows)`);
        } catch (err) {
            console.warn(`[${job.id}] Failed to build upload.csv`, err?.message || err);
        }

        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        pushState(job);
        console.log(`[${job.id}] Updating activeJob to completed...`);
        await updateActiveJob(job, 'completed', { uploadError: null, uploadMetrics: null });
        console.log(`[${job.id}] ActiveJob updated successfully`);
        log(job, `Job completed. Final CSV ready at ${job.paths.final}`);
    } catch (err) {
        if (job.cancelled) {
            markCancelled(job, 'Cancelled during processing');
            return;
        }
        // Handle paused jobs gracefully (e.g., credit exhaustion)
        if (err?.code === 'JOB_PAUSED') {
            console.log(`[${job.id}] Job paused gracefully`);
            closeStreams(job);
            return;
        }
        job.status = 'failed';
        job.error = err?.message || 'Unexpected pipeline error';
        pushState(job);
        await updateActiveJob(job, 'failed', { error: job.error, uploadError: null, uploadMetrics: null });
        log(job, `Job failed: ${job.error}`);
    }

}

async function upsertDomainsImmediately(job, domainsPath) {
    if (!job?.sqlClientId) {
        console.warn(`[${job?.id || 'unknown'}] Skipping domain upsert: missing sqlClientId`);
        return;
    }
    if (!domainsPath || !fs.existsSync(domainsPath)) {
        console.warn(`[${job?.id || 'unknown'}] Skipping domain upsert: domains file missing at ${domainsPath}`);
        return;
    }

    const domainColumn = job.columnMapping?.domain || 'domain';
    const domains = [];

    await new Promise((resolve, reject) => {
        fs.createReadStream(domainsPath)
            .pipe(csvParse({ columns: true, trim: true, skip_empty_lines: true }))
            .on('data', (row) => {
                const domain = String(row[domainColumn] || row.domain || '').trim().toLowerCase();
                if (domain) domains.push(domain);
            })
            .on('end', resolve)
            .on('error', reject);
    });

    if (!domains.length) {
        log(job, 'Domain upsert skipped: no domains found after parsing');
        return;
    }

    const uniqueDomains = Array.from(new Set(domains));

    try {
        const start = Date.now();
        await withTx(async (client) => {
            const payloads = uniqueDomains.map((domain) => ({ domain }));
            await batchUpsertCompanies(client, job.uid, job.sqlClientId, payloads);
        });
        log(job, `Domain upsert completed: ${uniqueDomains.length} domains in ${Date.now() - start}ms`);
    } catch (err) {
        console.error(`[${job?.id || 'unknown'}] Domain upsert failed:`, err?.message || err);
        log(job, 'Domain upsert failed', { error: err?.message || err });
    }
}


function serializeJob(job) {
    return {
        id: job.id,
        status: job.status,
        error: job.error,
        paused: job.paused || false,
        pausedAt: job.pausedAt || null,
        resumedAt: job.resumedAt || null,
        cancelled: job.cancelled || false,
        fileName: job.fileName,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        stages: job.stages,
        dedupeStats: job.dedupeStats || null,
        clientId: job.clientId,
        industry: job.industry || null,
        nicheId: job.nicheId || null,
        nicheLabel: job.nicheLabel || null,
        personalizeFirstLine: !!job.personalizeFirstLine,
        cost: typeof job.cost === 'number' ? job.cost : 0
    };
}

export { createJobRecord, resolveJobPaths, processJob, serializeJob, markCancelled, markPaused, markResumed, closeStreams, log as logJob };
