import { hydrateJobContext } from './hydrate.js';
import { reconcileJobStagesLive } from './reconcileStageCounts.js';

const DEFAULT_DEBOUNCE_MS = 1500;
const LOOP_INTERVAL_MS = 2000;

/** @type {Map<string, { timer: ReturnType<typeof setTimeout> | null, inFlight: Promise<unknown> | null }>} */
const debouncers = new Map();

function jobKey(jobId, agencyId) {
    return `${agencyId}:${jobId}`;
}

/**
 * Debounced reconcile after row mutations (upserts, domain marks, batch checkpoints).
 */
export function scheduleStageReconcile(jobId, agencyId, debounceMs = DEFAULT_DEBOUNCE_MS) {
    if (!jobId || !agencyId) return;

    if (debounceMs <= 0) {
        void runStageReconcile(jobId, agencyId).catch((err) => {
            console.warn(`[${jobId}] stage reconcile:`, err?.message || err);
        });
        return;
    }

    const key = jobKey(jobId, agencyId);
    let entry = debouncers.get(key);
    if (!entry) {
        entry = { timer: null, inFlight: null };
        debouncers.set(key, entry);
    }

    if (entry.timer) {
        clearTimeout(entry.timer);
    }

    entry.timer = setTimeout(() => {
        entry.timer = null;
        // Fire-and-forget: a reconcile failure (DB blip, pause race) must not surface as an
        // unhandledRejection — it's best-effort progress, the run continues regardless.
        entry.inFlight = runStageReconcile(jobId, agencyId)
            .catch((err) => {
                console.warn(`[${jobId}] stage reconcile (debounced): ${err?.message || err}`);
            })
            .finally(() => {
                if (entry.inFlight) entry.inFlight = null;
            });
    }, debounceMs);
}

/**
 * Immediate reconcile (e.g. domain prep complete, post-batch wave).
 */
export async function runStageReconcile(jobId, agencyId) {
    const ctx = await hydrateJobContext(jobId, agencyId);
    return reconcileJobStagesLive(ctx);
}

/**
 * Poll spreadsheet counts while parallel child batches run.
 * @param {{ jobId: string, agencyId: string, intervalMs?: number, shouldContinue?: () => boolean | Promise<boolean> }} opts
 */
export async function runStageReconcileLoop({
    jobId,
    agencyId,
    intervalMs = LOOP_INTERVAL_MS,
    shouldContinue
}) {
    const continueFn = shouldContinue || (async () => true);

    while (await continueFn()) {
        try {
            await runStageReconcile(jobId, agencyId);
        } catch (err) {
            console.warn(`[${jobId}] stage reconcile loop:`, err?.message || err);
        }

        if (!(await continueFn())) break;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    try {
        await runStageReconcile(jobId, agencyId);
    } catch (err) {
        console.warn(`[${jobId}] stage reconcile final tick:`, err?.message || err);
    }
}

export function clearStageReconcileScheduler(jobId, agencyId) {
    const key = jobKey(jobId, agencyId);
    const entry = debouncers.get(key);
    if (entry?.timer) {
        clearTimeout(entry.timer);
    }
    debouncers.delete(key);
}
