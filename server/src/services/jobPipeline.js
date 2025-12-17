import fs from 'fs';
import path from 'path';
import { env } from '../config/env.js';
import { admin, firestore } from '../config/firebase.js';
import { TMP_ROOT } from '../config/paths.js';
import { DEFAULT_PRICING, loadPricing, computeJobCost } from '../utils/pricing.js';
import { buildFoundersCsvFromInput, buildUnifiedRows, writeUploadCsv } from '../utils/csv.js';
import { filterAndWriteProcessedDomains, upsertLeadsFromCsv } from './leads.js';
import { runFounderFinder } from './founderFinder.js';
import { runEmailFinder } from './emailFinder.js';
import { runEmailVerifier } from './emailVerifier.js';
import { runPersonalization } from './personalization/index.js';

export const jobs = new Map();

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
        dedupeStrategy,
        cancelled: false,
        skipFounderFinder: options.skipFounderFinder || false,
        findFounder: options.findFounder !== false,
        industry: options.industry || options.nicheId || null,
        nicheId: options.nicheId || null,
        nicheLabel: options.nicheLabel || null,
        personalizeFirstLine: options.personalizeFirstLine === true,
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

            job.status = 'pending-upload';
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
                removeB2B: env.PERSONALIZATION_FILTER_B2B !== 'false',
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
        await upsertLeadsFromCsv({ uid: job.uid, clientId: job.clientId, csvPath: job.paths.personalized, type: 'personalization', dedupeStrategy: job.dedupeStrategy });

        // Build upload-ready CSV (valid/verified/valid-risky only)
        try {
            const uploadRows = await buildUnifiedRows({ jobId: job.id, scope: 'valid', resolveJobPaths });
            await writeUploadCsv(job.paths.upload, uploadRows);
            log(job, `Upload CSV ready at ${job.paths.upload} (${uploadRows.length} rows)`);
        } catch (err) {
            console.warn(`[${job.id}] Failed to build upload.csv`, err?.message || err);
        }

        job.status = 'pending-upload';
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
        industry: job.industry || null,
        nicheId: job.nicheId || null,
        nicheLabel: job.nicheLabel || null,
        personalizeFirstLine: !!job.personalizeFirstLine,
        cost: typeof job.cost === 'number' ? job.cost : 0
    };
}

export { createJobRecord, resolveJobPaths, processJob, serializeJob, markCancelled, log as logJob };
