/**
 * Enrow fallback behind TryKitt (per-agency opt-in, see enrowOptionsFromSettings).
 *
 *   find   — after the emails stage: founders TryKitt found no email for
 *   verify — after the verification stage: TryKitt risky/unknown verdicts
 *
 * Split into submit + collect so the Vercel child can wait between polls with a
 * durable workflow sleep (no function time burned while Enrow works); the PM2
 * runner uses runEnrowInline. Best-effort by design: an Enrow problem (no
 * credits, bad key, outage) is logged and skipped — it never fails or pauses the
 * enrichment batch, since TryKitt already produced a verdict for every row.
 * Rows are only stamped attempted once results are applied, so a batch that was
 * skipped or timed out is picked up again by a resume.
 */
import {
    submitEnrowFindBulk,
    submitEnrowVerifyBulk,
    getEnrowBulk,
    enrowBulkStatus,
    mapEnrowFindResults,
    mapEnrowVerifyResults,
    ENROW_BULK_MAX
} from '../../services/enrow.js';
import {
    getEnrowFindQueue,
    getEnrowVerifyQueue,
    getInflightEnrowRequest,
    getEnrowRequest,
    insertEnrowRequest,
    closeEnrowRequest,
    touchEnrowRequest,
    applyEnrowFindResults,
    applyEnrowVerifyResults
} from '../../services/db/enrow.js';
import { getJobById } from '../../services/db/jobs.js';
import { setJobActivity, touchJobHeartbeat } from '../persist.js';
import { shouldScheduleChildReconcile } from '../reconcilePolicy.js';

const STAGE_LABEL = { find: 'enrow-find', verify: 'enrow-verify' };

/** @param {import('../context.js').EnrichmentContext} ctx @param {'find' | 'verify'} kind */
export function isEnrowEnabled(ctx, kind) {
    if (!ctx.apiKeys?.enrow) return false;
    if (kind === 'find') return !!ctx.options?.enrow?.find && !ctx.options?.skipEmailFinder;
    return !!ctx.options?.enrow?.verify && !ctx.options?.skipVerification;
}

function logLine(ctx, kind, message) {
    console.log(`[${ctx.jobId}] [${STAGE_LABEL[kind]}] ${message}`);
}

async function reportActivity(ctx, kind, message) {
    logLine(ctx, kind, message);
    try {
        await setJobActivity(ctx.jobId, ctx.agencyId, message);
    } catch {
        // activity text is cosmetic
    }
}

function describeError(err) {
    if (err?.code === 'ENROW_CREDIT_EXHAUSTED') return 'Enrow is out of credits';
    if (err?.code === 'ENROW_UNAUTHORIZED') return 'Enrow rejected the API key';
    return `Enrow request failed (${err?.message || err})`;
}

/**
 * Submit this batch's Enrow work, or pick up the request a previous attempt
 * already submitted (step retry / resume) instead of paying for it twice.
 *
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {'find' | 'verify'} kind
 * @param {string[] | null} batchDomains null = whole job (PM2)
 * @param {{ batchKey: string | number }} opts
 * @returns {Promise<{ requestId: string, requested: number, reused: boolean } | null>}
 */
export async function submitEnrowBatch(ctx, kind, batchDomains, { batchKey }) {
    if (!isEnrowEnabled(ctx, kind)) return null;

    const inflight = await getInflightEnrowRequest(ctx.jobId, batchKey, kind);
    if (inflight) {
        logLine(ctx, kind, `reusing in-flight Enrow batch ${inflight.id} (${inflight.requested} rows)`);
        return { requestId: inflight.id, requested: inflight.requested, reused: true };
    }

    const jobRow = await getJobById(ctx.jobId, ctx.agencyId);
    const queueOpts = {
        reprocessInclude: String(ctx.options.dedupeStrategy || 'skip').toLowerCase() === 'include',
        jobStartedAt: jobRow?.created_at || null,
        domains: batchDomains,
        limit: ENROW_BULK_MAX
    };
    const queue = kind === 'find'
        ? await getEnrowFindQueue(ctx.agencyId, ctx.clientId, ctx.jobId, queueOpts)
        : await getEnrowVerifyQueue(ctx.agencyId, ctx.clientId, ctx.jobId, queueOpts);
    if (!queue.length) return null;

    const custom = { job_id: ctx.jobId, batch: String(batchKey), kind };
    let submitted;
    try {
        submitted = kind === 'find'
            ? await submitEnrowFindBulk(
                ctx.apiKeys.enrow,
                queue.map((r) => ({ contactId: r.contact_id, fullName: r.founder_name, domain: r.domain })),
                custom
            )
            : await submitEnrowVerifyBulk(ctx.apiKeys.enrow, queue.map((r) => r.email), custom);
    } catch (err) {
        await reportActivity(
            ctx,
            kind,
            `${describeError(err)} — skipped the Enrow ${kind === 'find' ? 'email-finder' : 'verifier'} fallback for ${queue.length} lead(s).`
        );
        return null;
    }

    const items = kind === 'find'
        ? queue.map((r) => ({ contact_id: r.contact_id }))
        : queue.map((r) => ({ contact_id: r.contact_id, email: r.email }));
    await insertEnrowRequest({
        id: submitted.id,
        agencyId: ctx.agencyId,
        clientId: ctx.clientId,
        jobId: ctx.jobId,
        batchKey,
        kind,
        items,
        creditsInitial: submitted.creditsUsed
    });
    await reportActivity(
        ctx,
        kind,
        kind === 'find'
            ? `Enrow: searching ${queue.length} email(s) TryKitt missed…`
            : `Enrow: re-checking ${queue.length} risky email(s)…`
    );
    return { requestId: submitted.id, requested: queue.length, reused: false };
}

/**
 * Poll one Enrow request; when it has finished, write the results.
 *
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {'find' | 'verify'} kind
 * @param {string} requestId
 * @returns {Promise<{ done: boolean, failed?: boolean, found?: number, valid?: number, invalid?: number }>}
 */
export async function collectEnrowBatch(ctx, kind, requestId) {
    const request = await getEnrowRequest(requestId);
    if (!request || request.status !== 'ongoing') return { done: true };

    let body;
    try {
        body = await getEnrowBulk(ctx.apiKeys.enrow, kind, requestId);
    } catch (err) {
        // GETs are free and unmetered: keep polling; a resume picks it up otherwise.
        logLine(ctx, kind, `poll failed for ${requestId}: ${err?.message || err}`);
        return { done: false };
    }

    const status = enrowBulkStatus(body);
    if (status === 'ongoing') {
        await touchEnrowRequest(requestId);
        await touchJobHeartbeat(ctx.jobId, ctx.agencyId).catch(() => {});
        return { done: false };
    }
    if (status === 'failed') {
        // Rows stay unstamped, so a resume submits them again.
        await closeEnrowRequest(requestId, { status: 'failed', error: 'Enrow reported the batch as failed' });
        await reportActivity(ctx, kind, `Enrow batch ${requestId} failed — those leads keep their TryKitt result.`);
        return { done: true, failed: true };
    }

    const items = Array.isArray(request.items) ? request.items : [];
    let result;
    if (kind === 'find') {
        const { found, credits } = mapEnrowFindResults(body, items);
        const { written, duplicates } = await applyEnrowFindResults(
            ctx.agencyId,
            items.map((i) => String(i.contact_id)),
            found
        );
        await closeEnrowRequest(requestId, { status: 'applied', found: written, creditsFinal: credits.final });
        await reportActivity(
            ctx,
            kind,
            `Enrow found ${written} of ${items.length} email(s) TryKitt missed`
                + (duplicates ? ` (${duplicates} skipped: address already on another lead)` : '')
                + (credits.final != null ? ` · ${credits.final} credit(s)` : '')
        );
        result = { done: true, found: written };
    } else {
        const { verdicts, credits } = mapEnrowVerifyResults(body, items);
        const counts = await applyEnrowVerifyResults(ctx.agencyId, items, verdicts);
        await closeEnrowRequest(requestId, { status: 'applied', found: counts.valid, creditsFinal: credits.final });
        await reportActivity(
            ctx,
            kind,
            `Enrow re-checked ${items.length} risky email(s): ${counts.valid} valid, ${counts.invalid} invalid`
                + (credits.final != null ? ` · ${credits.final} credit(s)` : '')
        );
        result = { done: true, valid: counts.valid, invalid: counts.invalid };
    }

    if (shouldScheduleChildReconcile(ctx)) {
        void import('../stageReconcileScheduler.js')
            .then(({ scheduleStageReconcile }) => scheduleStageReconcile(ctx.jobId, ctx.agencyId))
            .catch(() => {});
    }
    return result;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * In-process submit → poll → apply loop for the PM2 runner (whole job, chunks
 * of ENROW_BULK_MAX). Gives up waiting after `maxPolls`; the request stays
 * in flight and a resume collects it.
 *
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {'find' | 'verify'} kind
 * @param {{ pollMs?: number, maxPolls?: number, checkpoint?: () => Promise<void> }} [opts]
 */
export async function runEnrowInline(ctx, kind, { pollMs = 15_000, maxPolls = 40, checkpoint = null } = {}) {
    if (!isEnrowEnabled(ctx, kind)) return;
    // Each applied chunk stamps its rows, so the queue shrinks until empty.
    for (let chunk = 0; chunk < 100; chunk += 1) {
        const submitted = await submitEnrowBatch(ctx, kind, null, { batchKey: 'all' });
        if (!submitted) return;
        let done = false;
        let failed = false;
        for (let poll = 0; poll < maxPolls && !done; poll += 1) {
            await wait(pollMs);
            if (checkpoint) await checkpoint();
            ({ done, failed = false } = await collectEnrowBatch(ctx, kind, submitted.requestId));
        }
        // A failed batch leaves its rows unstamped; resubmitting here would loop.
        if (failed) return;
        if (!done) {
            await reportActivity(ctx, kind, `Enrow batch ${submitted.requestId} still running — resume the job later to collect it.`);
            return;
        }
        if (submitted.requested < ENROW_BULK_MAX) return;
    }
}
