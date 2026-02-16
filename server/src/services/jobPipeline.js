import fs from 'fs';
import path from 'path';
import { promises as dns } from 'dns';
import { admin, firestore } from '../config/firebase.js';
import { TMP_ROOT } from '../config/paths.js';
import { DEFAULT_PRICING, loadPricing, computeJobCost } from '../utils/pricing.js';
import { buildFoundersCsvFromInput, buildEmailsCsvFromInput, buildUnifiedRows, writeUploadCsv } from '../utils/csv.js';
import { filterAndWriteProcessedDomains, upsertLeadsFromCsv, upsertLeadRowsBatch } from './leads.js';
import { runFounderFinder } from './founderFinder.js';
import { runEmailFinder } from './emailFinder.js';
import { runEmailVerifier } from './emailVerifier.js';
import { runPersonalization } from './personalization/index.js';
import { ensureJobControl, readJobControl, writeJobControl } from './jobControl.js';
import { withTx, batchUpsertCompanies, batchUpsertContacts } from '../lib/db.js';
import { parse as csvParse } from 'csv-parse';
import { normalizeDomain } from '../utils/domain.js';

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
const DNS_QUERY_TIMEOUT_MS = 2500;
const DNS_CHECK_CONCURRENCY = 25;
const PLACEHOLDER_CONTACT_MAX_DOMAINS = Math.max(
    0,
    parseInt(process.env.PLACEHOLDER_CONTACT_MAX_DOMAINS || '5000', 10)
);

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

function syncJobControl(job) {
    if (!job?.id) return null;
    const control = readJobControl(job.id);
    if (control) {
        job.paused = !!control.paused;
        job.cancelled = !!control.cancelled;
    }
    return control;
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
            logs: Array.isArray(job.logs) ? job.logs.slice(-200) : [],
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
        if (err?.code === 'JOB_PAUSED') {
            throw err;
        }

        const message = err?.message || 'Unknown error';
        
        // Check for credit exhaustion error
        if (err?.code === 'CREDIT_EXHAUSTED') {
            console.log(`[${job.id}] Credit exhausted at stage ${stageKey}, pausing job`);
            updateStage(job, stageKey, { status: 'error', error: 'Add Credits to TryKitt' });
            await pauseJobWithError(job, 'Add Credits to TryKitt');
            throw createJobPausedError('Job paused due to credit exhaustion');
        }
        
        updateStage(job, stageKey, { status: 'error', completedAt: new Date().toISOString(), error: message });
        await pauseJobWithError(job, `Paused due to ${stageKey} stage error`, message);
        throw createJobPausedError(`Job paused due to ${stageKey} error: ${message}`);
    }
}

function markCancelled(job, reason = 'Cancelled by user') {
    job.cancelled = true;
    writeJobControl(job.id, { cancelled: true, paused: false });
    job.status = 'failed';  // Cancelled jobs are treated as failed in primary status
    job.error = reason;
    job.completedAt = job.completedAt || new Date().toISOString();
    pushState(job);
    closeStreams(job);
}

function markPaused(job, reason = 'Paused by user') {
    job.paused = true;
    writeJobControl(job.id, { paused: true });
    job.status = 'running';  // Paused jobs keep running status (can be resumed)
    job.pausedAt = new Date().toISOString();
    console.log(`[${job.id}] Job paused. paused=${job.paused}, status=${job.status}`);
    log(job, reason);
    pushState(job);
}

function markResumed(job) {
    job.paused = false;
    writeJobControl(job.id, { paused: false });
    job.status = 'running';
    job.resumedAt = new Date().toISOString();
    log(job, 'Job resumed.');
    pushState(job);
}

function createJobPausedError(message = 'Job paused') {
    const pauseError = new Error(message);
    pauseError.code = 'JOB_PAUSED';
    return pauseError;
}

async function pauseJobWithError(job, reason, errorMessage = null) {
    const resolvedReason = reason || 'Paused due to pipeline error';
    const resolvedError = errorMessage || resolvedReason;

    job.error = resolvedError;

    if (!job.paused) {
        markPaused(job, resolvedReason);
    } else {
        log(job, resolvedReason);
        pushState(job, true);
    }

    await updateActiveJob(job, 'paused', {
        error: resolvedError,
        uploadError: resolvedError,
        uploadMetrics: null,
        pausedAt: admin.firestore.FieldValue.serverTimestamp()
    });
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
        skipDomainCheck: options.skipDomainCheck === true,
        findFounder: options.findFounder !== false,
        industry: options.industry || options.nicheId || null,
        nicheId: options.nicheId || null,
        nicheLabel: options.nicheLabel || null,
        personalizeFirstLine: options.personalizeFirstLine === true,
        emailVerificationProvider: options.emailVerificationProvider || 'trykitt',
        columnMapping: options.columnMapping || { domain: 'domain', founder: '', email: '' },
        cost: 0,
        stages: {
            domainPrep: initialStageState(),
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

    ensureJobControl(id, { paused: false, cancelled: false });
    jobs.set(id, job);
    return job;
}

async function processJob(job) {
    syncJobControl(job);
    if (job.cancelled) {
        markCancelled(job, 'Cancelled before start');
        return;
    }

    job.status = 'running';
    pushState(job);
    await updateActiveJob(job, 'running', {
        uploadError: null,
        uploadMetrics: null,
        pausedAt: null
    });
    log(job, 'Job started.');

    try {
        // Load pricing configuration
        job.pricing = await loadPricing(job.uid);

        syncJobControl(job);
        if (job.cancelled) {
            markCancelled(job, 'Cancelled before start');
            return;
        }

        // Stage 1: normalize/remove www, dedupe, and optionally DNS-check domains.
        let filteredDomainsPath = job.paths.filtered;
        let preparedDomainsPath = filteredDomainsPath;
        await runStage(job, 'domainPrep', async () => {
            if (!preparedDomainsPath) {
                const { filtered, stats: dedupeStats } = await filterAndWriteProcessedDomains({
                    agencyId: job.uid,
                    clientId: job.sqlClientId,
                    jobId: job.id,
                    domainsCsvPath: job.paths.domains,
                    dedupeStrategy: job.dedupeStrategy,
                    domainColumn: job.columnMapping?.domain || 'domain'
                });
                preparedDomainsPath = filtered;
                job.dedupeStats = dedupeStats;
            }

            const { path: dedupedPath, removedDuplicates, totalRows, uniqueRows } = await dedupeDomainsCsv(
                preparedDomainsPath,
                job.columnMapping?.domain || 'domain'
            );
            preparedDomainsPath = dedupedPath;

            const domainCheckSkipped = job.skipDomainCheck === true;
            const dnsStats = domainCheckSkipped
                ? {
                    path: preparedDomainsPath,
                    checked: 0,
                    live: 0,
                    dead: 0,
                    unknown: 0,
                    processable: uniqueRows
                }
                : await dnsFilterDomainsCsv(
                    preparedDomainsPath,
                    job.columnMapping?.domain || 'domain'
                );

            if (!domainCheckSkipped) {
                preparedDomainsPath = dnsStats.path;
            }

            const normalized = typeof job.dedupeStats?.unique === 'number'
                ? job.dedupeStats.unique
                : totalRows;
            const duplicatesRemoved = (typeof job.dedupeStats?.duplicatesRemoved === 'number'
                ? job.dedupeStats.duplicatesRemoved
                : 0) + removedDuplicates;

            job.dedupeStats = {
                ...(job.dedupeStats || {}),
                totalRows,
                unique: normalized,
                duplicateRows: removedDuplicates,
                duplicatesRemoved,
                dnsChecked: dnsStats.checked,
                dnsLive: dnsStats.live,
                dnsDead: dnsStats.dead,
                dnsUnknown: dnsStats.unknown,
                processable: dnsStats.processable,
                domainCheckSkipped
            };

            if (domainCheckSkipped) {
                log(
                    job,
                    `Domain prep: normalized ${normalized}, deduped ${duplicatesRemoved}, domain check skipped, ${dnsStats.processable} processable`
                );
            } else {
                log(
                    job,
                    `Domain prep: normalized ${normalized}, deduped ${duplicatesRemoved}, DNS checked ${dnsStats.checked} (${dnsStats.live} live, ${dnsStats.dead} dead, ${dnsStats.unknown} unknown), ${dnsStats.processable} processable`
                );
            }

            // Keep this work inside Domain Prep so the next stage does not appear "stuck pending"
            // while we bulk-upsert domains/placeholders for large uploads.
            await upsertDomainsImmediately(job, preparedDomainsPath);

            return {
                total: typeof job.dedupeStats?.total === 'number' ? job.dedupeStats.total : totalRows,
                normalized,
                deduped: duplicatesRemoved,
                checked: dnsStats.checked,
                live: dnsStats.live,
                dead: dnsStats.dead,
                unknown: dnsStats.unknown,
                processable: dnsStats.processable,
                domainCheckSkipped,
                skippedExisting: typeof job.dedupeStats?.skipped === 'number' ? job.dedupeStats.skipped : 0,
                new: typeof job.dedupeStats?.new === 'number' ? job.dedupeStats.new : dnsStats.processable
            };
        });
        filteredDomainsPath = preparedDomainsPath;
        job.paths.prepared = filteredDomainsPath;

        // If no domains are left after domain prep, complete early.
        const processableCount = typeof job.dedupeStats?.processable === 'number'
            ? job.dedupeStats.processable
            : (typeof job.dedupeStats?.new === 'number' ? job.dedupeStats.new : 0);
        if (processableCount === 0) {
            fs.writeFileSync(job.paths.final, 'domain,email,email_status,founder_name\n');
            fs.writeFileSync(job.paths.personalized, 'domain,url,title,description,date,first_line\n');
            fs.writeFileSync(job.paths.upload, 'domain,founder_name,email,email_status,first_name,last_name,personalization\n');

            Object.entries(job.stages).forEach(([stageKey, stage]) => {
                if (stage.status === 'completed') {
                    return;
                }
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
            log(job, 'Job completed: No processable domains after normalization/dedupe/domain checks');
            return;
        }

        syncJobControl(job);
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
                const processed = (typeof job.dedupeStats?.processable === 'number' ? job.dedupeStats.processable : null)
                    ?? job.dedupeStats?.new
                    ?? job.dedupeStats?.unique
                    ?? job.dedupeStats?.total
                    ?? 0;
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
                    checkpointDir: job.tmpDir,
                    onBatch: async (rows) => {
                        await upsertLeadRowsBatch({
                            agencyId: job.uid,
                            clientId: job.sqlClientId,
                            rows,
                            type: 'founders',
                            jobId: job.id
                        });
                    }
                })
            );
        }
        computeJobCost(job);

        syncJobControl(job);
        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        syncJobControl(job);
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
                    checkPaused: () => {
                        syncJobControl(job);
                        return job.paused || job.cancelled;
                    },
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

        syncJobControl(job);
        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        syncJobControl(job);
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
                    checkPaused: () => {
                        syncJobControl(job);
                        return job.paused || job.cancelled;
                    }
                })
            );
        }
        computeJobCost(job);

        syncJobControl(job);
        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        // Upsert leads with verification status
        await upsertLeadsFromCsv({ agencyId: job.uid, clientId: job.sqlClientId, csvPath: job.paths.final, type: 'verification', jobId: job.id });

        syncJobControl(job);
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

        syncJobControl(job);
        if (job.cancelled) {
            markCancelled(job);
            return;
        }

        // Upsert leads with personalization data
        await upsertLeadsFromCsv({ agencyId: job.uid, clientId: job.sqlClientId, csvPath: job.paths.personalized, type: 'personalization', jobId: job.id });

        // Build upload-ready CSV (complete leads with founder, email, and personalization)
        const uploadRows = await buildUnifiedRows({ jobId: job.id, scope: 'complete', resolveJobPaths });
        await writeUploadCsv(job.paths.upload, uploadRows);
        log(job, `Upload CSV ready at ${job.paths.upload} (${uploadRows.length} rows)`);

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
        console.error(`[${job.id}] Pipeline error, pausing job:`, err?.message || err);
        await pauseJobWithError(job, 'Paused due to pipeline error', err?.message || 'Unexpected pipeline error');
        closeStreams(job);
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
                const domain = normalizeDomain(row[domainColumn] || row.domain);
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
        log(job, `Domain upsert starting: ${uniqueDomains.length} unique domains`);
        await withTx(async (client) => {
            const payloads = uniqueDomains.map((domain) => ({ domain }));
            const domainMap = await batchUpsertCompanies(client, job.uid, job.sqlClientId, payloads);

            // Create placeholder contacts (role founder) so UI can show empty leads immediately
            // For very large jobs this can significantly delay Founder Finder start.
            if (uniqueDomains.length <= PLACEHOLDER_CONTACT_MAX_DOMAINS) {
                const contactPayloads = Array.from(domainMap.values()).map((companyId) => ({
                    company_id: companyId,
                    role_type: 'founder'
                }));
                if (contactPayloads.length) {
                    await batchUpsertContacts(client, job.uid, job.sqlClientId, contactPayloads);
                }
            } else {
                log(
                    job,
                    `Domain upsert: skipped placeholder contacts for ${uniqueDomains.length} domains (threshold ${PLACEHOLDER_CONTACT_MAX_DOMAINS})`
                );
            }
        });
        log(job, `Domain upsert completed: ${uniqueDomains.length} domains in ${Date.now() - start}ms`);
    } catch (err) {
        console.error(`[${job?.id || 'unknown'}] Domain upsert failed:`, err?.message || err);
        log(job, 'Domain upsert failed', { error: err?.message || err });
        throw err;
    }
}

/**
 * Deduplicate a domains CSV by domain column. Returns path to deduped file.
 * If no duplicates are found, original path is returned.
 */
async function dedupeDomainsCsv(inputPath, domainColumn = 'domain') {
    if (!inputPath || !fs.existsSync(inputPath)) {
        return { path: inputPath, removedDuplicates: 0, totalRows: 0, uniqueRows: 0 };
    }

    const seen = new Set();
    const rows = [];
    let totalRows = 0;
    let removedDuplicates = 0;

    await new Promise((resolve, reject) => {
        fs.createReadStream(inputPath)
            .pipe(csvParse({ columns: true, trim: true, skip_empty_lines: true }))
            .on('data', (row) => {
                const domain = normalizeDomain(row[domainColumn] || row.domain);
                if (!domain) return;
                totalRows += 1;
                if (seen.has(domain)) {
                    removedDuplicates += 1;
                    return;
                }
                seen.add(domain);
                rows.push(domain);
            })
            .on('end', resolve)
            .on('error', reject);
    });

    if (removedDuplicates === 0) {
        return { path: inputPath, removedDuplicates, totalRows, uniqueRows: rows.length };
    }

    const ext = path.extname(inputPath);
    const dedupPath = inputPath.replace(ext, `-dedup${ext}`);
    const writer = fs.createWriteStream(dedupPath);
    writer.write('domain\n');
    rows.forEach((d) => writer.write(`${d}\n`));
    writer.end();
    await new Promise((resolve) => writer.on('finish', resolve));

    return { path: dedupPath, removedDuplicates, totalRows, uniqueRows: rows.length };
}

function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            const err = new Error(`DNS lookup timeout after ${timeoutMs}ms`);
            err.code = 'DNS_TIMEOUT';
            reject(err);
        }, timeoutMs);

        promise.then(
            (value) => {
                clearTimeout(timeout);
                resolve(value);
            },
            (error) => {
                clearTimeout(timeout);
                reject(error);
            }
        );
    });
}

function isDnsMiss(error) {
    const code = String(error?.code || '').toUpperCase();
    return (
        code === 'ENOTFOUND'
        || code === 'ENODATA'
        || code === 'ENONAME'
        || code === 'EAI_NONAME'
        || code === 'NXDOMAIN'
        || code === 'NOTFOUND'
        || code === 'NODATA'
    );
}

async function checkDomainDns(domain) {
    const lookups = [
        dns.resolve4(domain),
        dns.resolve6(domain),
        dns.resolveCname(domain),
        dns.resolveMx(domain)
    ].map((lookup) => withTimeout(lookup, DNS_QUERY_TIMEOUT_MS));

    const settled = await Promise.allSettled(lookups);
    const hasAnyRecord = settled.some(
        (result) => result.status === 'fulfilled' && Array.isArray(result.value) && result.value.length > 0
    );
    if (hasAnyRecord) {
        return { domain, status: 'live' };
    }

    const errors = settled
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
    if (errors.length > 0 && errors.every((error) => isDnsMiss(error))) {
        return { domain, status: 'dead' };
    }

    return { domain, status: 'unknown' };
}

async function mapWithConcurrency(items, concurrency, worker) {
    if (!Array.isArray(items) || items.length === 0) return [];

    const results = new Array(items.length);
    let cursor = 0;

    const runWorker = async () => {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) {
                return;
            }
            results[index] = await worker(items[index], index);
        }
    };

    const workerCount = Math.min(Math.max(concurrency, 1), items.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
}

async function dnsFilterDomainsCsv(inputPath, domainColumn = 'domain') {
    if (!inputPath || !fs.existsSync(inputPath)) {
        return { path: inputPath, checked: 0, live: 0, dead: 0, unknown: 0, processable: 0 };
    }

    const domains = [];
    await new Promise((resolve, reject) => {
        fs.createReadStream(inputPath)
            .pipe(csvParse({ columns: true, trim: true, skip_empty_lines: true }))
            .on('data', (row) => {
                const domain = normalizeDomain(row[domainColumn] || row.domain);
                if (domain) domains.push(domain);
            })
            .on('end', resolve)
            .on('error', reject);
    });

    const uniqueDomains = Array.from(new Set(domains));
    if (!uniqueDomains.length) {
        return { path: inputPath, checked: 0, live: 0, dead: 0, unknown: 0, processable: 0 };
    }

    const checks = await mapWithConcurrency(uniqueDomains, DNS_CHECK_CONCURRENCY, (domain) => checkDomainDns(domain));

    let live = 0;
    let dead = 0;
    let unknown = 0;
    const processableDomains = [];

    for (const result of checks) {
        if (result?.status === 'live') {
            live += 1;
            processableDomains.push(result.domain);
            continue;
        }
        if (result?.status === 'dead') {
            dead += 1;
            continue;
        }
        unknown += 1;
        if (result?.domain) {
            processableDomains.push(result.domain);
        }
    }

    const ext = path.extname(inputPath) || '.csv';
    const dnsPath = inputPath.replace(ext, `-dns${ext}`);
    const writer = fs.createWriteStream(dnsPath);
    writer.write('domain\n');
    processableDomains.forEach((domain) => writer.write(`${domain}\n`));
    writer.end();
    await new Promise((resolve) => writer.on('finish', resolve));

    return {
        path: dnsPath,
        checked: uniqueDomains.length,
        live,
        dead,
        unknown,
        processable: processableDomains.length
    };
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
        skipDomainCheck: !!job.skipDomainCheck,
        cost: typeof job.cost === 'number' ? job.cost : 0
    };
}

export { createJobRecord, resolveJobPaths, processJob, serializeJob, markCancelled, markPaused, markResumed, closeStreams, log as logJob };
