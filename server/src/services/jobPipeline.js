import fs from 'fs';
import os from 'os';
import path from 'path';
import { promises as dns } from 'dns';
import { env } from '../config/env.js';
import { logTimestamp } from '../utils/logTimestamp.js';
import { DEFAULT_PRICING, loadPricing, computeJobCost, normalizeStageSummary } from '../utils/pricing.js';
import { filterJobDomainsForDedupe, upsertLeadRowsBatch, upsertFounderSearchBatch } from './leads.js';
import { isNotFoundValue } from './enrichmentCohort.js';
import { runFounderFinder } from './founderFinder.js';
import { runEmailFinder } from './emailFinder.js';
import { runEmailVerifier } from './emailVerifier.js';
import { runPersonalization } from './personalization/index.js';
import { runPersonalization as runShoppingAuditPersonalization } from './personalization/strategies/shoppingAudit.js';
import {
    buildShoppingAuditStages,
    isShoppingAuditJob,
    runShoppingAuditPipeline
} from './shoppingAudit/index.js';
import { getAgencySettings, agencyFeaturesFromSettings, hasShoppingAuditFeature } from './db/agencySettings.js';
import { withTx, batchUpsertCompanies, batchUpsertContacts } from '../lib/db.js';
import { normalizeDomain } from '../utils/domain.js';
import {
    parseDomainsFromBuffer,
    bulkInsertJobDomains,
    listPendingJobDomains,
    countJobDomainsByStatus,
    markJobDomainsDone,
    markJobDomainsSkipped,
    markJobDomainsFounderExcluded,
    loadSerperCacheMap,
    upsertSerperCacheBatch,
    persistJobState as persistJobStateSql,
    setActiveJob,
    updateActiveJobStatus,
    syncJobControlFromDb,
    updateJobControl,
    getEmailFindQueue,
    getVerifyQueue,
    getPersonalizeQueue,
    jobHasRemainingPipelineWork,
    enrichJobDomainCohortFlags,
    markJobDomainFounderExcluded,
    listJobDomainsForJob,
    buildUnifiedRowsFromDb,
    countFinishedLeadsForJob,
    insertJob
} from './db/jobs.js';
import { pool } from '../config/db.js';
import { applyJobControlFileToJob, ensureJobControl, writeJobControl } from './jobControl.js';
import { createJobControlGate } from './jobControlGate.js';
import {
    initJobTiming,
    recordJobTiming,
    timeJobOp,
    makeUpsertTiming,
    logStageBreakdown,
    startCpuProbe,
    logCpuProbe
} from './jobTiming.js';

export const jobs = new Map();

const SQL_UPDATE_INTERVAL = 5;
const SQL_MIN_INTERVAL_MS = 2000;
const REALTIME_STAGE_MIN_INTERVAL_MS = 500;
import {
    DNS_QUERY_TIMEOUT_MS,
    DNS_CHECK_CONCURRENCY
} from '../enrichment/domainPrepConfig.js';
const PLACEHOLDER_CONTACT_MAX_DOMAINS = Math.max(
    0,
    parseInt(process.env.PLACEHOLDER_CONTACT_MAX_DOMAINS || '5000', 10)
);

function shouldUpdateSql(job) {
    if (job.__lastStatus !== job.status || job.status === 'completed' || job.status === 'failed') {
        job.__lastStatus = job.status;
        job.__lastSqlUpdate = Date.now();
        return true;
    }
    const activeStage = Object.keys(job.stages).find((key) => job.stages[key]?.status === 'running');
    const isRealtimeStage =
        activeStage === 'domainPrep'
        || activeStage === 'shopifyCatalog'
        || activeStage === 'heroSelection'
        || activeStage === 'serperShopping'
        || activeStage === 'signalWaterfall'
        || activeStage === 'founders'
        || activeStage === 'emailDiscovery'
        || activeStage === 'verification'
        || activeStage === 'personalization';
    const minInterval = isRealtimeStage ? REALTIME_STAGE_MIN_INTERVAL_MS : SQL_MIN_INTERVAL_MS;
    const now = Date.now();
    const timeSinceLastUpdate = now - (job.__lastSqlUpdate || 0);
    if (timeSinceLastUpdate < minInterval) return false;
    const currentCount = job.__updateCounter || 0;
    const threshold = isRealtimeStage ? 1 : SQL_UPDATE_INTERVAL;
    if (currentCount >= threshold) {
        job.__updateCounter = 0;
        job.__lastSqlUpdate = now;
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

function pushState(job, forceSqlUpdate = false, { includeTiming = forceSqlUpdate } = {}) {
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

    computeJobCost(job);

    if (forceSqlUpdate || shouldUpdateSql(job)) {
        persistJobState(job, { includeTiming }).catch(() => {});
    }
}

function setActivity(job, message) {
    if (!message) return;
    job.activity = { message, updatedAt: new Date().toISOString() };
    pushState(job, true);
}

function log(job, message = null, meta = {}) {
    if (message) {
        console.log(`[${job.id}] [${logTimestamp()}] ${message}`);
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
        
        job.__updateCounter = (job.__updateCounter || 0) + 1;

        pushState(job, false, { includeTiming: false });
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

async function syncJobControl(job) {
    if (!job?.id) return null;
    return syncJobControlFromDb(job);
}

async function persistJobState(job, { includeTiming = true } = {}) {
    if (!job?.id) return;
    const start = Date.now();
    try {
        await persistJobStateSql(job, { includeTiming });
        job.__persistedOnce = true;
        job.__persistStateTotalMs = (job.__persistStateTotalMs || 0) + (Date.now() - start);
        job.__persistStateCount = (job.__persistStateCount || 0) + 1;
    } catch (error) {
        console.error(`[${job?.id || 'unknown'}] Job persistence error:`, error?.message || error);
    }
}

async function updateActiveJob(job, status, additionalData = {}) {
    if (!job?.id) return;
    try {
        await updateActiveJobStatus(job.id, status, {
            uploadError: additionalData.uploadError ?? null,
            uploadMetrics: additionalData.uploadMetrics ?? null,
            status: job.status
        });
        if (status === 'running' || status === 'queued') {
            await setActiveJob(job.id, job.uid, job.sqlClientId);
        }
    } catch (error) {
        console.error(`[${job?.id || 'unknown'}] Active job update error:`, error?.message || error);
    }
}

async function runStage(job, stageKey, handler) {
    if (job.__lastStageCompleted) {
        recordJobTiming(job, {
            label: `gap:${job.__lastStageCompleted.stageKey}->${stageKey}`,
            category: 'stage_gap',
            durationMs: Date.now() - job.__lastStageCompleted.at,
            stage: stageKey,
            meta: { afterStage: job.__lastStageCompleted.stageKey }
        });
    } else if (job.__pipelineStartedAt) {
        recordJobTiming(job, {
            label: `gap:job_start->${stageKey}`,
            category: 'stage_gap',
            durationMs: Date.now() - job.__pipelineStartedAt,
            stage: stageKey,
            meta: { afterStage: 'job_start' }
        });
    }

    const stageStartedAt = Date.now();
    job.activity = null;
    updateStage(job, stageKey, { status: 'running', startedAt: new Date().toISOString(), error: null });
    try {
        const summary = await handler();
        applyJobControlFileToJob(job);
        if (job.cancelled) {
            throw createJobCancelledError('Job cancelled');
        }
        if (job.paused) {
            throw createJobPausedError('Job paused');
        }
        const safeSummary = normalizeStageSummary(summary || {});
        updateStage(job, stageKey, { status: 'completed', completedAt: new Date().toISOString(), summary: safeSummary });
        const stageDurationMs = Date.now() - stageStartedAt;
        recordJobTiming(job, {
            label: `stage:${stageKey}`,
            category: 'stage',
            durationMs: stageDurationMs,
            stage: stageKey
        });
        logStageBreakdown(job, stageKey, stageDurationMs, (message) => log(job, message));
        job.__lastStageCompleted = { stageKey, at: Date.now() };
        computeJobCost(job);
        pushState(job, true);
        return summary;
    } catch (err) {
        if (err?.code === 'JOB_PAUSED' || err?.code === 'JOB_CANCELLED') {
            throw err;
        }

        const message = err?.message || 'Unknown error';
        
        // Check for credit exhaustion error
        if (err?.code === 'CREDIT_EXHAUSTED') {
            console.log(`[${job.id}] [${logTimestamp()}] Credit exhausted at stage ${stageKey}, pausing job`);
            updateStage(job, stageKey, { status: 'error', error: 'Add Credits to TryKitt' });
            await pauseJobWithError(job, 'Add Credits to TryKitt');
            throw createJobPausedError('Job paused due to credit exhaustion');
        }
        
        updateStage(job, stageKey, { status: 'error', completedAt: new Date().toISOString(), error: message });
        await pauseJobWithError(job, `Paused due to ${stageKey} stage error`, message);
        throw createJobPausedError(`Job paused due to ${stageKey} error: ${message}`);
    }
}

async function markCancelled(job, reason = 'Cancelled by user') {
    job.cancelled = true;
    await updateJobControl(job.id, { cancelled: true, paused: false });
    job.status = 'failed';  // Cancelled jobs are treated as failed in primary status
    job.error = reason;
    job.completedAt = job.completedAt || new Date().toISOString();
    pushState(job);
}

async function markPaused(job, reason = 'Paused by user') {
    job.paused = true;
    writeJobControl(job.id, { paused: true, cancelled: false });
    await updateJobControl(job.id, { paused: true });
    job.status = 'running';  // Paused jobs keep running status (can be resumed)
    job.pausedAt = new Date().toISOString();
    console.log(`[${job.id}] [${logTimestamp()}] Job paused. paused=${job.paused}, status=${job.status}`);
    log(job, reason);
    pushState(job);
}

async function markResumed(job) {
    job.paused = false;
    writeJobControl(job.id, { paused: false, cancelled: false });
    await updateJobControl(job.id, { paused: false });
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

function createJobCancelledError(message = 'Job cancelled') {
    const err = new Error(message);
    err.code = 'JOB_CANCELLED';
    return err;
}

/** Pause/cancel from DB + control.json (stop button / other process / post-watch-restart). */
async function refreshJobControl(job) {
    if (!job?.id) return;
    applyJobControlFileToJob(job);
    try {
        await syncJobControlFromDb(job);
    } catch {
        /* noop */
    }
}

function makeCheckPaused(job) {
    return () => {
        applyJobControlFileToJob(job);
        return !!(job.paused || job.cancelled);
    };
}

async function pauseJobWithError(job, reason, errorMessage = null) {
    const resolvedReason = reason || 'Paused due to pipeline error';
    const resolvedError = errorMessage || resolvedReason;

    job.error = resolvedError;

    if (!job.paused) {
        await markPaused(job, resolvedReason);
    } else {
        log(job, resolvedReason);
        pushState(job, true);
    }

    await updateActiveJob(job, 'paused', {
        error: resolvedError,
        uploadError: resolvedError,
        uploadMetrics: null
    });
}

function resolveJobPaths(jobId) {
    const job = jobs.get(jobId);
    return { job, jobDir: null, finalPath: null, personalizedPath: null, uploadPath: null };
}

async function createJobRecord(fileBuffer, originalName, apiKeys, uid, clientId, dedupeStrategy = 'skip', options = {}) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const domainColumn = options.columnMapping?.domain || 'domain';
    const domainEntries = parseDomainsFromBuffer(fileBuffer, domainColumn);
    const pipelineMode = options.pipelineMode === 'shopping_audit' ? 'shopping_audit' : 'standard';

    const stages = {
        domainPrep: initialStageState(),
        ...(pipelineMode === 'shopping_audit' ? buildShoppingAuditStages(initialStageState) : {}),
        founders: initialStageState(),
        emailDiscovery: initialStageState(),
        verification: initialStageState(),
        personalization: initialStageState()
    };

    const jobOptions = {
        dedupeStrategy,
        pipelineMode,
        skipFounderFinder: !!options.skipFounderFinder,
        skipEmailFinder: !!options.skipEmailFinder,
        skipVerification: !!options.skipVerification,
        skipDomainCheck: options.skipDomainCheck === true,
        findFounder: options.findFounder !== false,
        industry: options.industry || options.nicheId || null,
        nicheId: options.nicheId || null,
        nicheLabel: options.nicheLabel || null,
        personalizeFirstLine: options.personalizeFirstLine === true,
        productPromptVersion: options.productPromptVersion || 'old',
        productPromptProducts: Number.isFinite(options.productPromptProducts) ? options.productPromptProducts : 3,
        emailVerificationProvider: options.emailVerificationProvider || 'trykitt',
        columnMapping: options.columnMapping || { domain: 'domain', founder: '', email: '' },
        initialStages: stages
    };

    await insertJob({
        id,
        agencyId: uid,
        clientId: options.sqlClientId,
        clientSlug: clientId,
        fileName: originalName,
        options: jobOptions,
        status: 'queued'
    });

    let bulkInsertMs = 0;
    if (domainEntries.length) {
        const bulkStart = Date.now();
        await bulkInsertJobDomains(id, uid, domainEntries);
        bulkInsertMs = Date.now() - bulkStart;
    }

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
        pipelineMode,
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
        productPromptVersion: options.productPromptVersion || 'old',
        productPromptProducts: Number.isFinite(options.productPromptProducts) ? options.productPromptProducts : 3,
        emailVerificationProvider: options.emailVerificationProvider || 'trykitt',
        columnMapping: options.columnMapping || { domain: 'domain', founder: '', email: '' },
        cost: 0,
        stages,
        paths: {},
        domainEntries
    };

    initJobTiming(job);
    if (bulkInsertMs > 0) {
        recordJobTiming(job, {
            label: 'bulkInsertJobDomains',
            category: 'upsert',
            durationMs: bulkInsertMs,
            rows: domainEntries.length
        });
        await persistJobState(job);
    }

    jobs.set(id, job);
    ensureJobControl(id, { paused: false, cancelled: false });
    return job;
}

async function dnsFilterJobDomains(job) {
    const pending = await listPendingJobDomains(job.id);
    const uniqueDomains = pending.map((r) => r.domain_normalized);
    if (!uniqueDomains.length) {
        return { checked: 0, live: 0, dead: 0, unknown: 0, processable: 0 };
    }

    const total = uniqueDomains.length;
    const reportEvery = Math.max(50, Math.floor(total / 40));
    let completed = 0;
    setActivity(job, `Checking DNS for ${total.toLocaleString()} domains…`);

    const gate = job.__controlGate;
    const checks = await mapWithConcurrency(uniqueDomains, DNS_CHECK_CONCURRENCY, async (domain) => {
        if (gate) await gate.checkpoint().catch((err) => { throw err; });
        const result = await checkDomainDns(domain);
        completed += 1;
        if (completed % reportEvery === 0 || completed === total) {
            log(job, `Domain prep: DNS ${completed.toLocaleString()} / ${total.toLocaleString()}`, {
                progress: { stage: 'domainPrep', processed: completed, total }
            });
        }
        return result;
    });
    let live = 0;
    let dead = 0;
    let unknown = 0;
    const deadDomains = [];

    for (const result of checks) {
        if (result?.status === 'live') {
            live += 1;
        } else if (result?.status === 'dead') {
            dead += 1;
            if (result.domain) deadDomains.push(result.domain);
        } else {
            unknown += 1;
        }
    }

    if (deadDomains.length) {
        await timeJobOp(
            job,
            { label: 'misc:markDeadDomains', category: 'misc', stage: 'domainPrep', rows: deadDomains.length },
            () => pool.query(
                `UPDATE job_domains SET status = 'skipped', updated_at = NOW()
                 WHERE job_id = $1 AND domain_normalized = ANY($2::text[])`,
                [job.id, deadDomains]
            )
        );
    }

    const counts = await countJobDomainsByStatus(job.id);
    return {
        checked: uniqueDomains.length,
        live,
        dead,
        unknown,
        processable: counts.pending || 0
    };
}

function isReprocessExistingDomains(job) {
    return String(job.dedupeStrategy || 'skip').toLowerCase() === 'include';
}

function enrichmentMergeMode(job) {
    return isReprocessExistingDomains(job) ? 'enrichment_b' : 'preserve';
}

function isStageCompleted(job, stageKey) {
    return job.stages?.[stageKey]?.status === 'completed';
}

async function hasRemainingPipelineWork(job) {
    return jobHasRemainingPipelineWork({
        agencyId: job.uid,
        clientId: job.sqlClientId,
        jobId: job.id,
        skipVerification: job.skipVerification,
        personalizeFirstLine: job.personalizeFirstLine,
        dedupeStrategy: job.dedupeStrategy,
        jobStartedAt: job.createdAt
    });
}

async function stageHasRemainingWork(job, stageKey) {
    const reprocessInclude = isReprocessExistingDomains(job);
    const limits = { reprocessInclude, limit: 1, jobStartedAt: job.createdAt };
    if (stageKey === 'founders' && !job.skipFounderFinder) {
        const pending = await listPendingJobDomains(job.id, 1);
        return pending.length > 0;
    }
    if (stageKey === 'emailDiscovery' && !job.skipEmailFinder) {
        const queue = await getEmailFindQueue(job.uid, job.sqlClientId, job.id, limits);
        return queue.length > 0;
    }
    if (stageKey === 'verification' && !job.skipVerification) {
        const queue = await getVerifyQueue(job.uid, job.sqlClientId, job.id, limits);
        return queue.length > 0;
    }
    if (stageKey === 'personalization' && job.personalizeFirstLine) {
        const queue = await getPersonalizeQueue(job.uid, job.sqlClientId, job.id, limits);
        return queue.length > 0;
    }
    return false;
}

async function runStageIfNeeded(job, stageKey, handler) {
    if (isStageCompleted(job, stageKey)) {
        if (!(await stageHasRemainingWork(job, stageKey))) {
            log(job, `Skipping ${stageKey} (already completed)`);
            return job.stages[stageKey]?.summary;
        }
        log(job, `Re-running ${stageKey} (incomplete work remaining)`);
    }
    return runStage(job, stageKey, handler);
}

async function resolveProcessableCount(job) {
    const fromStats = job.dedupeStats?.processable ?? job.dedupeStats?.new;
    if (typeof fromStats === 'number' && fromStats > 0) {
        return fromStats;
    }
    const counts = await countJobDomainsByStatus(job.id);
    return (counts.done || 0) + (counts.processing || 0) + (counts.pending || 0);
}

async function handleFounderBatch(job, rows) {
    if (!rows?.length) return;
    await upsertFounderSearchBatch({
        agencyId: job.uid,
        clientId: job.sqlClientId,
        jobId: job.id,
        rows,
        mergeMode: enrichmentMergeMode(job),
        onTiming: makeUpsertTiming(job, 'founders')
    });
}

async function processJob(job) {
    await syncJobControl(job);
    if (job.cancelled) {
        await markCancelled(job, 'Cancelled before start');
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
    initJobTiming(job);
    job.__pipelineStartedAt = Date.now();
    job.__cpuProbe = startCpuProbe();

    try {
        let agencySettings;
        await timeJobOp(job, { label: 'misc:loadPricing', category: 'misc' }, async () => {
            job.pricing = await loadPricing(job.uid);
            agencySettings = await getAgencySettings(job.uid);
            job.auditFeatures = agencyFeaturesFromSettings(agencySettings);
        });
        if (isShoppingAuditJob(job) && !hasShoppingAuditFeature(agencySettings)) {
            throw new Error('Shopping audit pipeline is not enabled for this agency.');
        }

        await syncJobControl(job);
        if (job.cancelled) {
            await markCancelled(job, 'Cancelled before start');
            return;
        }

        const gate = createJobControlGate(job);
        job.__controlGate = gate;

        const totalUploaded = (job.domainEntries || []).length;
        const pendingBeforePrep = await listPendingJobDomains(job.id, 1);
        const skipDomainPrep =
            isStageCompleted(job, 'domainPrep')
            || (pendingBeforePrep.length === 0 && job.dedupeStats?.processable > 0);

        if (skipDomainPrep) {
            log(job, 'Skipping domain prep (resume — already processed)');
            if (!job.dedupeStats?.processable) {
                const restored = await resolveProcessableCount(job);
                job.dedupeStats = {
                    ...(job.dedupeStats || {}),
                    processable: restored,
                    total: job.dedupeStats?.total ?? restored
                };
            }
        } else {
            await runStage(job, 'domainPrep', async () => {
                await gate.checkpoint();
                const reauditMonths = isShoppingAuditJob(job)
                    ? Number(job.auditFeatures?.reauditMonths ?? 4)
                    : null;
                const dedupeResult = await timeJobOp(
                    job,
                    { label: 'misc:dedupeFilter', category: 'misc', stage: 'domainPrep', rows: totalUploaded },
                    () => filterJobDomainsForDedupe({
                        agencyId: job.uid,
                        clientId: job.sqlClientId,
                        jobId: job.id,
                        dedupeStrategy: job.dedupeStrategy,
                        reauditMonths
                    })
                );

                const domainCheckSkipped = job.skipDomainCheck === true;
                const dnsStats = domainCheckSkipped
                    ? { checked: 0, live: 0, dead: 0, unknown: 0, processable: dedupeResult.stats.new }
                    : await timeJobOp(
                        job,
                        { label: 'misc:dnsFilter', category: 'misc', stage: 'domainPrep', rows: dedupeResult.stats.new },
                        () => dnsFilterJobDomains(job)
                    );

                job.dedupeStats = {
                    total: totalUploaded,
                    unique: totalUploaded,
                    duplicatesRemoved: 0,
                    skipped: dedupeResult.stats.skipped,
                    existing: dedupeResult.stats.existing,
                    new: dedupeResult.stats.new,
                    dnsChecked: dnsStats.checked,
                    dnsLive: dnsStats.live,
                    dnsDead: dnsStats.dead,
                    dnsUnknown: dnsStats.unknown,
                    processable: dnsStats.processable,
                    domainCheckSkipped
                };

                await upsertDomainsImmediately(job);

                log(
                    job,
                    domainCheckSkipped
                        ? `Domain prep: ${totalUploaded} uploaded, ${job.dedupeStats.skipped} skipped (existing), ${dnsStats.processable} processable`
                        : `Domain prep: DNS checked ${dnsStats.checked}, ${dnsStats.processable} processable`
                );

                return {
                    total: totalUploaded,
                    normalized: totalUploaded,
                    deduped: 0,
                    checked: dnsStats.checked,
                    live: dnsStats.live,
                    dead: dnsStats.dead,
                    unknown: dnsStats.unknown,
                    processable: dnsStats.processable,
                    domainCheckSkipped,
                    skippedExisting: job.dedupeStats.skipped,
                    new: job.dedupeStats.new
                };
            });
        }

        const cohortTotal = await resolveProcessableCount(job);
        if (!skipDomainPrep) {
            setActivity(job, `Applying upload column rules to ${cohortTotal.toLocaleString()} domains…`);
            await timeJobOp(
                job,
                { label: 'misc:enrichCohortFlags', category: 'misc', rows: cohortTotal },
                async () => enrichJobDomainCohortFlags(job.id, job.columnMapping || {}, async ({ processed, total }) => {
                    if (processed % 500 === 0 || processed === total) {
                        await gate.checkpoint();
                        setActivity(
                            job,
                            `Applying upload column rules… ${processed.toLocaleString()} / ${total.toLocaleString()}`
                        );
                    }
                })
            );
            log(job, `Upload column rules applied to ${cohortTotal.toLocaleString()} domains`);
            job.activity = null;
            pushState(job, true);
        }

        let processableCount = await resolveProcessableCount(job);
        job.__cpuProbeDomainCount = processableCount;
        if (processableCount === 0 && await hasRemainingPipelineWork(job)) {
            const counts = await countJobDomainsByStatus(job.id);
            processableCount = Math.max(
                (counts.done || 0) + (counts.processing || 0) + (counts.pending || 0),
                1
            );
            job.dedupeStats = { ...(job.dedupeStats || {}), processable: processableCount };
            log(job, `Resume: continuing pipeline (${processableCount} domains in job, enrichment work remaining)`);
        }
        if (processableCount === 0) {
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

        await syncJobControl(job);
        if (job.cancelled) {
            await markCancelled(job);
            return;
        }

        const domainCounts = await countJobDomainsByStatus(job.id);
        const totalForJob = Object.values(domainCounts).reduce((a, b) => a + b, 0);

        if (isShoppingAuditJob(job)) {
            const pendingAuditDomains = (await listPendingJobDomains(job.id)).map((r) => r.domain_normalized);
            if (pendingAuditDomains.length && !isStageCompleted(job, 'signalWaterfall')) {
                setActivity(job, `Running shopping audit for ${pendingAuditDomains.length.toLocaleString()} domains…`);
                const auditResult = await runShoppingAuditPipeline({
                    job,
                    domains: pendingAuditDomains,
                    features: job.auditFeatures,
                    log: (message, meta) => log(job, message, meta),
                    setActivity: (message) => setActivity(job, message),
                    recordTiming: (spec) => recordJobTiming(job, spec),
                    checkpoint: () => gate.checkpoint(),
                    updateStage: (stageKey, handler) => runStageIfNeeded(job, stageKey, handler),
                    pricing: job.pricing,
                    enableHeadless: process.env.SHOPPING_AUDIT_HEADLESS === 'true',
                    enableTier2: true,
                    enableBrokenPage: process.env.SHOPPING_AUDIT_HEADLESS === 'true'
                });

                job.signalByDomain = auditResult.signalByDomain;
                const toSkip = [
                    ...(auditResult.skipDomains?.not_shopify || []),
                    ...(auditResult.skipDomains?.no_signal || [])
                ];
                if (toSkip.length) {
                    await timeJobOp(
                        job,
                        { label: 'misc:markAuditSkippedDomains', category: 'misc', rows: toSkip.length },
                        () => markJobDomainsSkipped(job.id, toSkip)
                    );
                    log(job, `Shopping audit skipped ${toSkip.length} domains (not Shopify or no signal)`);
                }
                computeJobCost(job);
            } else if (job.signalByDomain == null) {
                job.signalByDomain = new Map();
            }
        }

        if (job.skipFounderFinder) {
            await runStageIfNeeded(job, 'founders', async () => {
                const founderCol = job.columnMapping?.founder || 'founder_name';
                const pending = await timeJobOp(
                    job,
                    { label: 'misc:loadPendingDomains', category: 'misc', stage: 'founders' },
                    () => listPendingJobDomains(job.id)
                );
                const total = pending.length;
                log(job, `Founders from CSV: loaded ${total.toLocaleString()} pending domains`);

                const founderRows = [];
                const excludedDomains = [];
                const doneDomains = [];
                const progressEvery = 500;

                for (let i = 0; i < pending.length; i += 1) {
                    if (i % 100 === 0) await gate.checkpoint();
                    const row = pending[i];
                    const raw = row.raw_row || {};
                    const founder = String(raw[founderCol] || raw.founder_name || '').trim();
                    if (isNotFoundValue(founder)) {
                        excludedDomains.push(row.domain_normalized);
                        founderRows.push({ domain: row.domain_normalized, founder_name: '' });
                        doneDomains.push(row.domain_normalized);
                        continue;
                    }
                    if (founder) {
                        founderRows.push({ domain: row.domain_normalized, founder_name: founder });
                        doneDomains.push(row.domain_normalized);
                    }
                    const processed = i + 1;
                    if (processed % progressEvery === 0 || processed === total) {
                        log(job, `Founders from CSV: ${processed.toLocaleString()} / ${total.toLocaleString()}`, {
                            progress: { stage: 'founders', processed, total }
                        });
                    }
                }

                if (doneDomains.length) {
                    await timeJobOp(
                        job,
                        { label: 'misc:markFoundersDone', category: 'misc', stage: 'founders', rows: doneDomains.length },
                        () => markJobDomainsDone(job.id, doneDomains)
                    );
                }
                if (founderRows.length) {
                    await upsertFounderSearchBatch({
                        agencyId: job.uid,
                        clientId: job.sqlClientId,
                        jobId: job.id,
                        rows: founderRows,
                        mergeMode: enrichmentMergeMode(job),
                        onTiming: makeUpsertTiming(job, 'founders')
                    });
                }

                log(job, `Founders from CSV: upserted ${founderRows.length.toLocaleString()} founders`);
                return {
                    processed: founderRows.length,
                    excluded: excludedDomains.length,
                    cost: 0
                };
            });
            log(job, `Founders skipped (upload included founder). Processed ${job.stages.founders?.summary?.processed ?? 0} domains.`);
        } else {
            setActivity(job, `Starting founder lookup for ${processableCount.toLocaleString()} domains…`);
            await runStageIfNeeded(job, 'founders', () =>
                runFounderFinder({
                    listPendingDomains: () => listPendingJobDomains(job.id),
                    loadSerperCache: () => loadSerperCacheMap(job.id),
                    saveSerperCache: (entries) => upsertSerperCacheBatch(job.id, entries),
                    markDomainsDone: (domains) => markJobDomainsDone(job.id, domains),
                    checkpoint: () => gate.checkpoint(),
                    checkPaused: () => gate.checkPaused(),
                    jobId: job.id,
                    agencyId: job.uid,
                    totalDomainCount: totalForJob,
                    apiKeys: job.apiKeys,
                    pricing: job.pricing?.stages?.founders || DEFAULT_PRICING.stages.founders,
                    log: (message, meta) => log(job, message, meta),
                    onBatch: async (rows) => handleFounderBatch(job, rows)
                })
            );
        }
        computeJobCost(job);

        await syncJobControl(job);
        if (job.cancelled) return await markCancelled(job);

        if (job.skipEmailFinder) {
            await runStageIfNeeded(job, 'emailDiscovery', async () => {
                const emailCol = job.columnMapping?.email || 'email';
                const excludeSkipped = !isReprocessExistingDomains(job);
                const loadStart = Date.now();
                const jobDomains = await listJobDomainsForJob(job.id, {
                    emailCohortOnly: true,
                    excludeSkipped
                });
                const total = jobDomains.length;
                log(
                    job,
                    excludeSkipped
                        ? `Email from CSV: loaded ${total.toLocaleString()} new domains (${Date.now() - loadStart}ms)`
                        : `Email from CSV: loaded ${total.toLocaleString()} domains (${Date.now() - loadStart}ms)`
                );
                setActivity(job, `Importing emails from CSV… 0 / ${total.toLocaleString()}`);

                const pendingBatch = [];
                let imported = 0;
                const BATCH_SIZE = 50;
                const progressEvery = 50;

                const flushEmailBatch = async () => {
                    if (!pendingBatch.length) return;
                    const batch = pendingBatch.splice(0, pendingBatch.length);
                    await upsertLeadRowsBatch({
                        agencyId: job.uid,
                        clientId: job.sqlClientId,
                        rows: batch,
                        type: 'emails',
                        jobId: job.id,
                        mergeMode: enrichmentMergeMode(job),
                        onTiming: makeUpsertTiming(job, 'emailDiscovery')
                    });
                    imported += batch.length;
                };

                for (let i = 0; i < jobDomains.length; i += 1) {
                    if (i % 100 === 0) await gate.checkpoint();
                    const jd = jobDomains[i];
                    const raw = jd.raw_row || {};
                    const email = String(raw[emailCol] || raw.email || '').trim();
                    if (!isNotFoundValue(email)) {
                        pendingBatch.push({
                            domain: jd.domain_normalized,
                            founder_name:
                                String(raw[job.columnMapping?.founder || 'founder_name'] || raw.founder_name || '').trim()
                                || null,
                            email,
                            lookup_status: 'found'
                        });
                    }
                    if (pendingBatch.length >= BATCH_SIZE) {
                        await flushEmailBatch();
                    }
                    const processed = i + 1;
                    if (processed % progressEvery === 0 || processed === total) {
                        log(job, `Email from CSV: ${processed.toLocaleString()} / ${total.toLocaleString()}`, {
                            progress: {
                                stage: 'emailDiscovery',
                                processed,
                                total,
                                found: imported,
                                stats: { Found: imported, imported }
                            }
                        });
                        setActivity(
                            job,
                            `Importing emails from CSV… ${processed.toLocaleString()} / ${total.toLocaleString()}`
                        );
                    }
                }
                await flushEmailBatch();
                return { processed: total, found: imported, Found: imported, cost: 0 };
            });
            log(job, `Email discovery skipped (upload included email). Processed ${job.stages.emailDiscovery?.summary?.processed ?? 0} rows.`);
        } else {
            const reprocessInclude = isReprocessExistingDomains(job);
            const queueLimit = Math.max(totalForJob, processableCount, 5000);
            await runStageIfNeeded(job, 'emailDiscovery', async () => {
                const queueRows = await timeJobOp(
                    job,
                    { label: 'misc:loadEmailQueue', category: 'misc', stage: 'emailDiscovery' },
                    () => getEmailFindQueue(
                        job.uid,
                        job.sqlClientId,
                        job.id,
                        { reprocessInclude, limit: queueLimit, jobStartedAt: job.createdAt }
                    )
                );
                if (!queueRows.length) {
                    const prior = job.stages?.emailDiscovery?.summary || {};
                    log(job, 'Emails: no remaining lookups (already completed for this job).');
                    return {
                        processed: prior.processed ?? 0,
                        found: prior.found ?? prior.Found ?? 0,
                        cost: prior.cost ?? 0,
                        resumed: true
                    };
                }
                const foundersStageTotal = job.stages?.founders?.summary?.processed;
                const jobEmailTotal =
                    typeof foundersStageTotal === 'number' && foundersStageTotal > 0
                        ? foundersStageTotal
                        : processableCount > 0
                          ? processableCount
                          : queueRows.length;
                const progressTotal = jobEmailTotal;
                // queueRows.length reflects what's left to do (queue filter excludes
                // already-completed rows in skip mode; in reprocess/include mode the
                // queue contains every founder for the upload). Either way, the
                // derived offset is the correct "done so far" count for THIS run.
                const derivedOffset = Math.max(0, jobEmailTotal - queueRows.length);
                const progressOffset = Math.min(jobEmailTotal, derivedOffset);

                log(
                    job,
                    progressOffset > 0
                        ? `Emails: ${queueRows.length} remaining (${progressOffset}/${progressTotal} done for this upload).`
                        : `Emails: ${queueRows.length} lookup(s) queued (${progressTotal} in cohort).`
                );
                const founders = queueRows.map((r) => ({
                    domain: r.domain,
                    founder_name: r.founder_name
                }));
                return runEmailFinder({
                    founders,
                    apiKeys: job.apiKeys,
                    provider: job.emailVerificationProvider,
                    pricing: job.pricing?.stages?.emailDiscovery || DEFAULT_PRICING.stages.emailDiscovery,
                    progressOffset,
                    progressTotal,
                    log: (message, meta) => log(job, message, meta),
                    job,
                    checkpoint: () => gate.checkpoint(),
                    checkPaused: () => gate.checkPaused(),
                    refreshControl: () => gate.refresh(),
                    onBatch: async (rows) => {
                        await upsertLeadRowsBatch({
                            agencyId: job.uid,
                            clientId: job.sqlClientId,
                            rows,
                            type: 'emails',
                            jobId: job.id,
                            mergeMode: enrichmentMergeMode(job),
                            onTiming: makeUpsertTiming(job, 'emailDiscovery')
                        });
                    }
                });
            });
        }
        computeJobCost(job);

        await syncJobControl(job);
        if (job.cancelled) return await markCancelled(job);
        if (job.paused) {
            throw createJobPausedError('Job paused');
        }

        if (job.skipVerification) {
            await runStageIfNeeded(job, 'verification', async () => {
                const verified = await pool.query(
                    `SELECT email_status FROM contacts WHERE job_id = $1 AND email IS NOT NULL`,
                    [job.id]
                );
                const stats = { valid: 0, invalid: 0, 'valid-risky': 0, unknown: 0 };
                for (const row of verified.rows) {
                    const s = String(row.email_status || 'unknown').toLowerCase();
                    if (stats[s] !== undefined) stats[s] += 1;
                    else stats.unknown += 1;
                }
                return { processed: verified.rows.length, cost: 0, ...stats };
            });
            log(job, 'Verification skipped (pre-verified in upload).');
        } else {
            const reprocessInclude = isReprocessExistingDomains(job);
            const queueLimit = Math.max(totalForJob, processableCount, 5000);
            const candidates = (
                await timeJobOp(
                    job,
                    { label: 'misc:loadVerifyQueue', category: 'misc', stage: 'verification' },
                    () => getVerifyQueue(job.uid, job.sqlClientId, job.id, {
                        reprocessInclude,
                        limit: queueLimit,
                        jobStartedAt: job.createdAt
                    })
                )
            ).map((r) => ({
                domain: r.domain,
                founder_name: r.founder_name,
                email: r.email,
                lookup_status: r.email_status
            }));
            await runStageIfNeeded(job, 'verification', () =>
                runEmailVerifier({
                    candidates,
                    apiKeys: job.apiKeys,
                    provider: job.emailVerificationProvider,
                    pricing: job.pricing?.stages?.verification || DEFAULT_PRICING.stages.verification,
                    log: (message, meta) => log(job, message, meta),
                    job,
                    checkpoint: () => gate.checkpoint(),
                    checkPaused: () => gate.checkPaused(),
                    refreshControl: () => gate.refresh(),
                    onBatch: async (rows) => {
                        await upsertLeadRowsBatch({
                            agencyId: job.uid,
                            clientId: job.sqlClientId,
                            rows,
                            type: 'verification',
                            jobId: job.id,
                            mergeMode: enrichmentMergeMode(job),
                            onTiming: makeUpsertTiming(job, 'verification')
                        });
                    }
                })
            );
        }
        computeJobCost(job);

        await syncJobControl(job);
        if (job.cancelled) return await markCancelled(job);

        if (job.personalizeFirstLine) {
            const reprocessInclude = isReprocessExistingDomains(job);
            const queueLimit = Math.max(totalForJob, processableCount, 5000);
            const personalizeCandidates = (
                await timeJobOp(
                    job,
                    { label: 'misc:loadPersonalizeQueue', category: 'misc', stage: 'personalization' },
                    () => getPersonalizeQueue(job.uid, job.sqlClientId, job.id, {
                        reprocessInclude,
                        requireValidEmail: reprocessInclude,
                        limit: queueLimit
                    })
                )
            ).map((r) => ({
                domain: r.domain,
                founder_name: r.founder_name,
                email: r.email,
                email_status: r.email_status
            }));

            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `personalize-${job.id}-`));
            const inputCsv = path.join(tmpDir, 'final.csv');
            const outputCsv = path.join(tmpDir, 'personalized.csv');
            await timeJobOp(
                job,
                { label: 'misc:writePersonalizeCsv', category: 'misc', stage: 'personalization', rows: personalizeCandidates.length },
                async () => {
                    const writer = fs.createWriteStream(inputCsv);
                    writer.write('domain,founder_name,email,email_status\n');
                    for (const row of personalizeCandidates) {
                        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
                        writer.write(`${esc(row.domain)},${esc(row.founder_name)},${esc(row.email)},${esc(row.email_status)}\n`);
                    }
                    writer.end();
                    await new Promise((resolve) => writer.on('finish', resolve));
                }
            );

            const personalizeTotal = personalizeCandidates.length;
            log(job, `Starting personalization for ${personalizeTotal} leads…`);

            if (isShoppingAuditJob(job)) {
                await runStageIfNeeded(job, 'personalization', () =>
                    runShoppingAuditPersonalization({
                        rows: personalizeCandidates,
                        apiKeys: job.apiKeys,
                        log: (message, meta) => log(job, message, meta),
                        recordTiming: (spec) => recordJobTiming(job, { stage: 'personalization', ...spec }),
                        signalEmissionByDomain: job.signalByDomain || new Map(),
                        templates: job.auditFeatures?.signalTemplates,
                        checkpoint: () => gate.checkpoint(),
                        onBatch: async (rows) => {
                            if (!rows?.length) return;
                            await upsertLeadRowsBatch({
                                agencyId: job.uid,
                                clientId: job.sqlClientId,
                                rows: rows.map((r) => ({
                                    domain: r.domain,
                                    first_line: r.first_line,
                                    signal_emission_id: r.signal_emission_id
                                })),
                                type: 'personalization',
                                jobId: job.id,
                                mergeMode: enrichmentMergeMode(job),
                                onTiming: makeUpsertTiming(job, 'personalization')
                            });
                        }
                    })
                );
            } else {
                await runStageIfNeeded(job, 'personalization', () =>
                    runPersonalization({
                        inputCsv,
                        outputCsv,
                        apiKeys: job.apiKeys,
                        log: (message, meta) => log(job, message, meta),
                        removeB2B: false,
                        industry: job.industry || job.nicheId || null,
                        nicheId: job.nicheId || null,
                        nicheLabel: job.nicheLabel || null,
                        personalizeFirstLine: job.personalizeFirstLine,
                        productPromptVersion: job.productPromptVersion || 'old',
                        productPromptProducts: Number.isFinite(job.productPromptProducts) ? job.productPromptProducts : 3,
                        checkpoint: () => gate.checkpoint(),
                        onBatch: async (rows) => {
                            await upsertLeadRowsBatch({
                                agencyId: job.uid,
                                clientId: job.sqlClientId,
                                rows,
                                type: 'personalization',
                                jobId: job.id,
                                mergeMode: enrichmentMergeMode(job),
                                onTiming: makeUpsertTiming(job, 'personalization')
                            });
                        }
                    })
                );
            }
        } else {
            updateStage(job, 'personalization', {
                status: 'completed',
                completedAt: new Date().toISOString(),
                summary: { skipped: true, personalized: 0 },
                progress: { stage: 'personalization', processed: 0, total: 0 }
            });
            log(job, 'Personalization skipped (not enabled for this job).');
        }
        computeJobCost(job);

        await syncJobControl(job);
        if (job.cancelled) return await markCancelled(job);

        setActivity(job, 'Finalizing job results…');
        const finishedCount = await timeJobOp(
            job,
            { label: 'misc:finalizeCountLeads', category: 'misc' },
            () => countFinishedLeadsForJob(job.id)
        );
        job.activity = null;
        log(job, `Job complete: ${finishedCount} leads ready for export`);

        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        recordJobTiming(job, {
            label: 'job:total',
            category: 'stage',
            durationMs: Date.now() - (job.__pipelineStartedAt || Date.now())
        });
        if (job.__persistStateTotalMs > 0) {
            recordJobTiming(job, {
                label: 'upsert:jobStatePersist',
                category: 'upsert',
                durationMs: job.__persistStateTotalMs,
                meta: { writes: job.__persistStateCount || 0 }
            });
        }
        pushState(job, true);
        logCpuProbe({
            ...job.__cpuProbe,
            domainCount: job.__cpuProbeDomainCount
                ?? job.dedupeStats?.processable
                ?? (job.domainEntries || []).length,
            jobId: job.id
        });
        await updateActiveJob(job, 'completed', { uploadError: null, uploadMetrics: null });
        log(job, 'Job completed.');
    } catch (err) {
        await refreshJobControl(job);
        if (job.cancelled || err?.code === 'JOB_CANCELLED') {
            await markCancelled(job, 'Cancelled during processing');
            return;
        }
        // Handle paused jobs gracefully (e.g., credit exhaustion)
        if (err?.code === 'JOB_PAUSED') {
            console.log(`[${job.id}] [${logTimestamp()}] Job paused gracefully`);
            if (!job.paused) {
                await markPaused(job, 'Paused during processing');
            }
            pushState(job, true);
            return;
        }
        console.error(`[${job.id}] Pipeline error, pausing job:`, err?.message || err);
        await pauseJobWithError(job, 'Paused due to pipeline error', err?.message || 'Unexpected pipeline error');
    }

}

async function upsertDomainsImmediately(job) {
    if (!job?.sqlClientId) {
        console.warn(`[${job?.id || 'unknown'}] Skipping domain upsert: missing sqlClientId`);
        return;
    }

    const pending = await listPendingJobDomains(job.id);
    const uniqueDomains = pending.map((r) => r.domain_normalized).filter(Boolean);

    if (!uniqueDomains.length) {
        log(job, 'Domain upsert skipped: no pending domains');
        return;
    }

    try {
        log(job, `Domain upsert starting: ${uniqueDomains.length} unique domains`);
        let companiesMs = 0;
        let contactsMs = 0;
        const upsertStart = Date.now();

        await withTx(async (client) => {
            const companiesStart = Date.now();
            const payloads = uniqueDomains.map((domain) => ({ domain }));
            const domainMap = await batchUpsertCompanies(client, job.uid, job.sqlClientId, payloads);
            companiesMs = Date.now() - companiesStart;

            if (uniqueDomains.length <= PLACEHOLDER_CONTACT_MAX_DOMAINS) {
                const contactPayloads = Array.from(domainMap.values()).map((companyId) => ({
                    company_id: companyId,
                    role_type: 'founder',
                    job_id: job.id
                }));
                if (contactPayloads.length) {
                    const contactsStart = Date.now();
                    await batchUpsertContacts(client, job.uid, job.sqlClientId, contactPayloads);
                    contactsMs = Date.now() - contactsStart;
                }
            } else {
                log(
                    job,
                    `Domain upsert: skipped placeholder contacts for ${uniqueDomains.length} domains (threshold ${PLACEHOLDER_CONTACT_MAX_DOMAINS})`
                );
            }
        });

        recordJobTiming(job, {
            label: 'upsert:initialDomainCompanies',
            category: 'upsert',
            durationMs: companiesMs,
            rows: uniqueDomains.length,
            stage: 'domainPrep'
        });
        if (contactsMs > 0) {
            recordJobTiming(job, {
                label: 'upsert:initialDomainPlaceholders',
                category: 'upsert',
                durationMs: contactsMs,
                rows: uniqueDomains.length,
                stage: 'domainPrep'
            });
        }
        recordJobTiming(job, {
            label: 'upsert:initialDomains',
            category: 'upsert',
            durationMs: Date.now() - upsertStart,
            rows: uniqueDomains.length,
            stage: 'domainPrep',
            meta: { companiesMs, contactsMs }
        });
        log(job, `Domain upsert completed: ${uniqueDomains.length} domains in ${Date.now() - upsertStart}ms`);
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
        cost: typeof job.cost === 'number' ? job.cost : 0,
        activityMessage: job.activity?.message || null,
        activityUpdatedAt: job.activity?.updatedAt || null,
        dedupeStrategy: job.dedupeStrategy || 'skip',
        pipelineMode: job.pipelineMode || 'standard',
        sqlClientId: job.sqlClientId || null,
        skipFounderFinder: !!job.skipFounderFinder,
        skipEmailFinder: !!job.skipEmailFinder,
        skipVerification: !!job.skipVerification,
        findFounder: job.findFounder !== false,
        emailVerificationProvider: job.emailVerificationProvider || 'trykitt',
        columnMapping: job.columnMapping || { domain: 'domain', founder: '', email: '' },
        filteredPath: job.paths?.filtered || null,
        clientId: job.clientId,
        industry: job.industry || null,
        nicheId: job.nicheId || null,
        nicheLabel: job.nicheLabel || null,
        personalizeFirstLine: !!job.personalizeFirstLine,
        productPromptVersion: job.productPromptVersion || 'old',
        productPromptProducts: Number.isFinite(job.productPromptProducts) ? job.productPromptProducts : 3,
        skipDomainCheck: !!job.skipDomainCheck,
        timingTotals: job.timingTotals || {},
        timingLog: job.timingLog || []
    };
}

/**
 * Signal in-flight inline jobs to stop (SIGINT / server shutdown).
 */
export function requestJobsShutdown(reason = 'Server shutting down') {
    let count = 0;
    for (const job of jobs.values()) {
        if (job.status === 'running' || job.status === 'queued') {
            job.cancelled = true;
            count += 1;
            console.log(`[${job.id}] [${logTimestamp()}] Shutdown requested: ${reason}`);
        }
    }
    return count;
}

export async function cancelActiveJobsOnShutdown(reason = 'Server shutting down') {
    const active = [...jobs.values()].filter((j) => j.status === 'running' || j.status === 'queued');
    for (const job of active) {
        job.cancelled = true;
        try {
            await markCancelled(job, reason);
        } catch (err) {
            console.error(`[${job?.id || 'unknown'}] Shutdown cancel error:`, err?.message || err);
        }
    }
    return active.length;
}

export { createJobRecord, resolveJobPaths, processJob, serializeJob, markCancelled, markPaused, markResumed, log as logJob };
