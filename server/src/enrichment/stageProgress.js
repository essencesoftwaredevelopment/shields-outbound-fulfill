import { pool } from '../config/db.js';
import { normalizeStageSummary, extractStageCostAmount } from '../utils/pricing.js';

export const WORKFLOW_BATCH_SIZE = 100;

function maxNum(a, b) {
    const na = typeof a === 'number' && Number.isFinite(a) ? a : null;
    const nb = typeof b === 'number' && Number.isFinite(b) ? b : null;
    if (na === null && nb === null) return null;
    return Math.max(na ?? 0, nb ?? 0);
}

function sumNum(a, b) {
    const na = typeof a === 'number' && Number.isFinite(a) ? a : null;
    const nb = typeof b === 'number' && Number.isFinite(b) ? b : null;
    if (na === null && nb === null) return null;
    return (na ?? 0) + (nb ?? 0);
}

function mergeCounter(mode, a, b) {
    return mode === 'sum' ? sumNum(a, b) : maxNum(a, b);
}

/** How parallel child batches combine in-flight progress counters. */
const STAGE_PROGRESS_MERGE = {
    founders: { processed: 'max', found: 'sum', total: 'max', cost: 'sum' },
    emailDiscovery: { processed: 'sum', found: 'sum', total: 'sum', cost: 'sum' },
    verification: { processed: 'max', found: 'sum', total: 'max', cost: 'sum' },
    personalization: { processed: 'sum', found: 'sum', total: 'sum', cost: 'sum' }
};

const DEFAULT_PROGRESS_MERGE = { processed: 'max', found: 'sum', total: 'max', cost: 'sum' };

const STATS_SUM_KEYS = new Set([
    'Found', 'found', 'Not Found', 'not_found', 'notFound', 'errors', 'Errors',
    'Skipped', 'skipped', 'personalized', 'Personalized', 'valid', 'Valid',
    'invalid', 'Invalid', 'unknown', 'Unknown', 'valid-risky', 'Valid-Risky'
]);
const STATS_MAX_KEYS = new Set(['Total', 'total', 'Processed', 'processed', 'RPM']);

function stripBatchMeta(progress) {
    if (!progress || typeof progress !== 'object') return {};
    const { batches, _batchIndex, batchIndex, ...rest } = progress;
    return rest;
}

export function aggregateBatchSlots(batches, stageKey) {
    const slots = Object.values(batches || {}).filter((s) => s && typeof s === 'object');
    if (!slots.length) return null;

    const rules = STAGE_PROGRESS_MERGE[stageKey] || DEFAULT_PROGRESS_MERGE;
    const aggregated = { stage: stageKey, batches };

    for (const field of ['processed', 'found', 'total', 'cost']) {
        const mode = rules[field] || 'max';
        let value = null;
        for (const slot of slots) {
            const n = slot[field];
            if (typeof n !== 'number' || !Number.isFinite(n)) continue;
            value = value === null ? n : mergeCounter(mode, value, n);
        }
        if (value !== null) aggregated[field] = value;
    }

    const mergedStats = {};
    for (const slot of slots) {
        const stats = slot.stats;
        if (!stats || typeof stats !== 'object') continue;
        for (const [key, val] of Object.entries(stats)) {
            if (typeof val !== 'number' || !Number.isFinite(val)) continue;
            const mode = STATS_SUM_KEYS.has(key)
                ? 'sum'
                : STATS_MAX_KEYS.has(key)
                    ? 'max'
                    : 'max';
            mergedStats[key] = mergedStats[key] === undefined
                ? val
                : mergeCounter(mode, mergedStats[key], val);
        }
    }
    if (Object.keys(mergedStats).length) {
        aggregated.stats = mergedStats;
    }

    return aggregated;
}

/** Mirror frontend mergeStageProgress — per-batch slots, then aggregate. */
export function mergeStageProgress(prior, next, stageKey) {
    if (!next) return prior ? { ...prior } : null;

    const batchIndex = next._batchIndex ?? next.batchIndex;
    const batches = { ...(prior?.batches || {}) };

    if (batchIndex !== undefined && batchIndex !== null) {
        batches[String(batchIndex)] = stripBatchMeta(next);
    } else if (!prior) {
        return { ...next };
    }

    const aggregated = aggregateBatchSlots(batches, stageKey);
    if (!aggregated) return prior ? { ...prior } : null;

    if (prior && batchIndex === undefined) {
        for (const field of ['processed', 'found', 'total', 'cost']) {
            if (typeof prior[field] === 'number' && typeof aggregated[field] !== 'number') {
                aggregated[field] = prior[field];
            }
        }
    }

    return aggregated;
}

/** Job-wide totals repeated per batch — never sum these across children. */
const SUMMARY_MAX_KEYS = new Set(['total', 'Total']);
export function mergeStageSummary(prior, next) {
    if (!prior) return next ? { ...next } : null;
    if (!next) return { ...prior };
    const merged = { ...prior, ...next };
    for (const key of new Set([...Object.keys(prior), ...Object.keys(next)])) {
        if (key === 'cost' || key === 'Cost' || key === 'Estimated Cost') continue;
        const p = prior[key];
        const n = next[key];
        if (typeof p === 'number' && typeof n === 'number') {
            merged[key] = SUMMARY_MAX_KEYS.has(key) ? maxNum(p, n) : p + n;
        } else if (n !== undefined && n !== null && (p === undefined || p === null)) {
            merged[key] = n;
        }
    }
    const priorCost = extractStageCostAmount({ summary: prior });
    const nextCost = extractStageCostAmount({ summary: next });
    const totalCost = priorCost + nextCost;
    if (totalCost > 0) {
        merged.cost = Number(totalCost.toFixed(6));
        merged.Cost = `$${merged.cost.toFixed(2)}`;
    }
    return merged;
}

/**
 * Rebuild user-facing progress from merged batch summaries when a stage closes.
 */
export function buildCanonicalProgress(stageKey, summary, jobTotal, priorProgress = {}) {
    const s = summary || {};
    const base = {
        stage: stageKey,
        total: jobTotal,
        ...(priorProgress && typeof priorProgress === 'object' ? priorProgress : {})
    };

    if (stageKey === 'founders') {
        const found = Number(s.Found ?? s.found ?? 0);
        const notFound = Number(s['Not Found'] ?? s.notFound ?? 0);
        const errors = Number(s.Errors ?? s.errors ?? 0);
        const processed = typeof s.processed === 'number'
            ? s.processed
            : found + notFound + errors;
        return {
            ...base,
            total: jobTotal,
            processed: jobTotal > 0 ? Math.min(jobTotal, processed) : processed,
            found,
            stats: {
                Total: jobTotal,
                Processed: processed,
                Found: found,
                'Not Found': notFound,
                Errors: errors,
                Cost: s.Cost
            }
        };
    }

    if (stageKey === 'emailDiscovery') {
        const found = Number(s.Found ?? s.found ?? 0);
        const notFound = Number(s['Not Found'] ?? s.notFound ?? 0);
        const errors = Number(s.errors ?? s.Errors ?? 0);
        const checked = found + notFound + errors;
        const eligible = typeof s.eligible === 'number' ? s.eligible : checked;
        return {
            ...base,
            total: jobTotal,
            processed: checked,
            found,
            stats: {
                Found: found,
                'Not Found': notFound,
                errors,
                Skipped: Number(s.Skipped ?? s.skipped ?? 0),
                Cost: s.Cost
            },
            eligible
        };
    }

    if (stageKey === 'verification') {
        const verified = Number(s.Verified ?? s.verified ?? 0);
        const valid = Number(s.Valid ?? s.valid ?? 0);
        return {
            ...base,
            total: jobTotal,
            processed: verified,
            stats: {
                valid,
                Valid: valid,
                invalid: Number(s.Invalid ?? s.invalid ?? 0),
                'valid-risky': Number(s['Valid-Risky'] ?? s['valid-risky'] ?? 0),
                unknown: Number(s.Unknown ?? s.unknown ?? 0),
                Cost: s.Cost
            }
        };
    }

    if (stageKey === 'personalization') {
        const personalized = Number(s.Personalized ?? s.personalized ?? s.processed ?? 0);
        const eligible = typeof s.eligible === 'number' ? s.eligible : null;
        const total = eligible ?? (typeof s.total === 'number' ? s.total : jobTotal);
        return {
            ...base,
            total: total ?? jobTotal,
            processed: personalized,
            stats: {
                personalized,
                Personalized: personalized,
                Cost: s.Cost
            },
            candidates: total ?? personalized
        };
    }

    if (stageKey === 'domainPrep') {
        const processable = Number(s.processable ?? s.checked ?? jobTotal ?? 0);
        return {
            ...base,
            total: jobTotal || processable,
            processed: processable
        };
    }

    return base;
}

function ensureSummaryCost(summary, progress) {
    const out = normalizeStageSummary(summary || {});
    const amount = extractStageCostAmount({ summary: out, progress });
    if (amount > 0) {
        out.cost = Number(amount.toFixed(6));
        if (!out.Cost) out.Cost = `$${out.cost.toFixed(2)}`;
    }
    return out;
}

function ensureProgressCost(progress, summary) {
    const out = { ...(progress || {}) };
    const amount = extractStageCostAmount({ summary, progress: out });
    if (amount > 0) {
        out.cost = Math.max(out.cost || 0, amount);
        if (out.stats && typeof out.stats === 'object') {
            out.stats = {
                ...out.stats,
                cost: out.cost,
                Cost: `$${out.cost.toFixed(2)}`
            };
        }
    }
    return out;
}

export function resolveJobTotal(ctx) {
    const prep = ctx.stages?.domainPrep?.summary;
    if (typeof prep?.processable === 'number' && prep.processable > 0) {
        return prep.processable;
    }
    if (typeof prep?.checked === 'number' && prep.checked > 0) {
        return prep.checked;
    }
    return null;
}

export function batchProgressOffset(batchIndex = 0, batchSize = WORKFLOW_BATCH_SIZE) {
    const size = Number.isFinite(batchSize) && batchSize > 0 ? batchSize : WORKFLOW_BATCH_SIZE;
    return Math.max(0, batchIndex) * size;
}

function remapProgressForJob(progress, stageKey, { jobTotal, progressOffset }) {
    if (!progress || typeof progress !== 'object') return null;
    const remapped = { ...progress, stage: stageKey };
    if (typeof progress.processed === 'number') {
        const local = progress.processed;
        remapped.processed =
            jobTotal != null
                ? Math.min(jobTotal, progressOffset + local)
                : progressOffset + local;
    }
    if (jobTotal != null) {
        remapped.total = jobTotal;
    } else if (typeof progress.total === 'number') {
        remapped.total = progressOffset + progress.total;
    }
    if (typeof progress.found === 'number' && progressOffset > 0) {
        // found is batch-local in runners; mergeStageProgress max handles parallel batches.
    }
    return remapped;
}

/** Per-job in-process queues so at most one pool client per process waits on the row lock. */
const stagesWriteChains = new Map();

/**
 * Serialize read-modify-write cycles on jobs.stages. Every writer (batch progress,
 * cost merges, live/final reconciles) runs in parallel across the parent and child
 * worker processes; without serialization a writer holding a stale read clobbers a
 * fresher write and progress visibly goes backwards. In-process calls are chained
 * per job, and `SELECT ... FOR UPDATE` serializes across processes.
 *
 * `mutate(row)` receives the locked jobs row and returns the next stages object,
 * or null/undefined to skip the write.
 */
export function updateJobStagesLocked(jobId, agencyId, mutate) {
    const chainKey = `${agencyId}:${jobId}`;

    const run = async () => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Prevent a wedged reconcile (or any slow mutate) from holding FOR UPDATE
            // forever and blocking Pause/Stop. Idle-in-transaction is how the Vulcan
            // shopping-audit hang bricked the job row for 20+ minutes.
            await client.query(`SET LOCAL idle_in_transaction_session_timeout = '20s'`);
            await client.query(`SET LOCAL lock_timeout = '15s'`);
            const { rows } = await client.query(
                `SELECT * FROM jobs WHERE id = $1 AND agency_id = $2 FOR UPDATE`,
                [jobId, agencyId]
            );
            if (!rows.length) {
                await client.query('ROLLBACK');
                return null;
            }
            const next = await mutate(rows[0]);
            if (next) {
                await client.query(
                    `UPDATE jobs SET stages = $3::jsonb, updated_at = NOW() WHERE id = $1 AND agency_id = $2`,
                    [jobId, agencyId, JSON.stringify(next)]
                );
            }
            await client.query('COMMIT');
            return next;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    };

    const prior = stagesWriteChains.get(chainKey) || Promise.resolve();
    const result = prior.then(run, run);
    // Keep the chain alive on failure without swallowing the caller's error.
    stagesWriteChains.set(chainKey, result.catch(() => {}));
    return result;
}

export async function persistStageProgress(jobId, agencyId, stageKey, patch) {
    await updateJobStagesLocked(jobId, agencyId, (row) => {
        const stages = { ...(row.stages || {}) };
        const prior = stages[stageKey] || {};
        const next = { ...patch };

        if (patch.progress) {
            next.progress = mergeStageProgress(prior.progress, patch.progress, stageKey);
        }
        if (patch.summary) {
            next.summary = mergeStageSummary(prior.summary, patch.summary);
        }

        stages[stageKey] = { ...prior, ...next };
        return stages;
    });
}

/** Merge API-reported cost only — batches no longer own progress/status.
 * Writes to job_stage_costs (atomic increment) instead of jobs.stages JSON.
 */
export async function persistStageCostOnly(jobId, agencyId, stageKey, patch = {}) {
    const amount = extractStageCostAmount({ summary: patch, progress: patch });
    if (!(amount > 0)) return;

    const { addJobStageCost } = await import('../services/db/jobStageCosts.js');
    await addJobStageCost(jobId, agencyId, stageKey, amount);
}

/**
 * Log hook for stage runners — console + cost + reconcile tick (spreadsheet owns progress).
 */
export function createStageLogger(ctx, stageKey, options = {}) {
    const { label = stageKey } = options;

    let lastReconcileAt = 0;
    const MIN_RECONCILE_MS = 1500;

    return (message, meta) => {
        if (message) {
            console.log(`[${ctx.jobId}] [${label}] ${message}`);
        }

        const now = Date.now();
        if (now - lastReconcileAt < MIN_RECONCILE_MS) return;
        lastReconcileAt = now;

        void import('./stageReconcileScheduler.js').then(({ scheduleStageReconcile }) => {
            // Debounce across parallel child isolates — immediate (0) reconciles used to
            // stampede countJobStageStats while holding the jobs row lock.
            scheduleStageReconcile(ctx.jobId, ctx.agencyId);
        }).catch(() => {});
    };
}

/** Activity only — stage status/counts come from spreadsheet reconcile. */
export async function beginJobStage(ctx, stageKey, { activity } = {}) {
    if (activity) {
        const { setJobActivity } = await import('./persist.js');
        await setJobActivity(ctx.jobId, ctx.agencyId, activity);
    }
    const { scheduleStageReconcile } = await import('./stageReconcileScheduler.js');
    scheduleStageReconcile(ctx.jobId, ctx.agencyId);
}

/** Cost merge + reconcile — batches no longer set status/summary/progress. */
export async function finishJobStage(ctx, stageKey, batchSummary) {
    if (batchSummary && Object.keys(batchSummary).length) {
        const normalized = normalizeStageSummary(batchSummary);
        await persistStageCostOnly(ctx.jobId, ctx.agencyId, stageKey, normalized);
    }
    const { scheduleStageReconcile } = await import('./stageReconcileScheduler.js');
    scheduleStageReconcile(ctx.jobId, ctx.agencyId, 0);
}

/**
 * Spreadsheet reconcile immediately before finalize.
 * @returns {Promise<Record<string, unknown>>}
 */
export async function syncStagesBeforeFinalize(jobId, agencyId) {
    const { runStageReconcile } = await import('./stageReconcileScheduler.js');
    return runStageReconcile(jobId, agencyId);
}
