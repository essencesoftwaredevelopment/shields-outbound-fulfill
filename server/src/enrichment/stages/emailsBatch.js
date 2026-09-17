import { runEmailFinder } from '../../services/emailFinder.js';
import { getEmailFindQueue, getJobById, listJobDomainsForJob } from '../../services/db/jobs.js';
import { upsertLeadRowsBatch, upsertCsvEmailRowsBatch } from '../../services/leads.js';
import { isNotFoundValue, normalizeCsvEmailStatus } from '../../services/enrichmentCohort.js';
import { assertJobActive } from '../persist.js';
import { createRateLimitHooks } from '../rateLimit.js';
import { contextToJob } from '../context.js';
import {
    beginJobStage,
    finishJobStage,
    createStageLogger
} from '../stageProgress.js';
import { shouldScheduleChildReconcile } from '../reconcilePolicy.js';

function enrichmentMergeMode(ctx) {
    return String(ctx.options.dedupeStrategy || 'skip').toLowerCase() === 'include'
        ? 'enrichment_b'
        : 'preserve';
}

const CSV_EMAIL_UPSERT_CHUNK = 50;

/**
 * Map job_domains rows to `emails` upsert rows from the upload's column mapping.
 * Rows whose email cell is empty / "Not Found" are dropped. An unmapped column
 * falls back to a literal `email` / `founder_name` key (lead_filter seeds).
 * A mapped emailStatus column adds a normalized `email_status` (null when the
 * cell is empty); the caller decides whether to persist it.
 *
 * @param {Array<{ domain_normalized: string, raw_row?: Record<string, unknown> | null }>} jobDomains
 * @param {{ email?: string, founder?: string, emailStatus?: string } | null | undefined} columnMapping
 * @returns {Array<{ domain: string, founder_name: string | null, email: string, email_status: string | null }>}
 */
export function buildCsvEmailRows(jobDomains, columnMapping) {
    const mapping = columnMapping || {};
    const emailCol = String(mapping.email || '').trim();
    const founderCol = String(mapping.founder || '').trim();
    const statusCol = String(mapping.emailStatus || '').trim();
    const rows = [];
    for (const jd of jobDomains) {
        const raw = jd.raw_row && typeof jd.raw_row === 'object' ? jd.raw_row : {};
        const email = String((emailCol ? raw[emailCol] : undefined) ?? raw.email ?? '').trim();
        if (isNotFoundValue(email)) continue;
        const founder = String((founderCol ? raw[founderCol] : undefined) ?? raw.founder_name ?? '').trim();
        rows.push({
            domain: jd.domain_normalized,
            // Null keeps the existing full_name (COALESCE in the emails upsert clause).
            founder_name: isNotFoundValue(founder) ? null : founder,
            email,
            email_status: statusCol ? normalizeCsvEmailStatus(raw[statusCol]) : null
        });
    }
    return rows;
}

/**
 * "Upload included email": copy the mapped email column from job_domains.raw_row
 * onto the founder contact so the verify/personalize queues can see it. Mirrors
 * the legacy runner's CSV import in jobPipeline.js; before this the workflow
 * runner only stamped the stage complete and never wrote the emails, so only
 * contacts that already had an email from an earlier job went on to verify.
 * When verification is skipped and an email-status column is mapped, the CSV
 * status is written too (stamped as verified, so the stage counts and the
 * export/Instantly gates see it). With verification on, the status is left for
 * the verifier: a stamp here would drop the row out of the verify queue.
 * Idempotent per domain (upsert), so step retries and resume batches are safe.
 *
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {string[]} batchDomains
 * @param {{ batchIndex: number, stageLog: (message: string, meta?: object) => void }} opts
 */
async function importCsvEmailsBatch(ctx, batchDomains, { batchIndex, stageLog }) {
    const jobDomains = await listJobDomainsForJob(ctx.jobId, {
        emailCohortOnly: true,
        excludeSkipped: true,
        domains: batchDomains
    });

    await beginJobStage(ctx, 'emailDiscovery', {
        activity: `Importing emails from CSV (${jobDomains.length})…`,
        batchIndex
    });

    const mergeMode = enrichmentMergeMode(ctx);
    const rows = buildCsvEmailRows(jobDomains, ctx.options.columnMapping);
    const importStatus = !!ctx.options.skipVerification;
    let imported = 0;
    let statusImported = 0;

    for (let i = 0; i < rows.length; i += CSV_EMAIL_UPSERT_CHUNK) {
        const chunk = rows.slice(i, i + CSV_EMAIL_UPSERT_CHUNK);
        await assertJobActive(ctx.jobId, ctx.agencyId);
        const written = await upsertCsvEmailRowsBatch({
            agencyId: ctx.agencyId,
            clientId: ctx.clientId,
            rows: chunk,
            jobId: ctx.jobId,
            mergeMode,
            importStatus,
            reconcileAfterWrite: shouldScheduleChildReconcile(ctx)
        });
        imported += chunk.length;
        statusImported += written.statusRows;
        stageLog(`Email from CSV: ${imported} / ${rows.length}`);
    }

    const summary = {
        skipped: true,
        processed: jobDomains.length,
        imported,
        Found: imported,
        found: imported,
        statusImported,
        cost: 0
    };
    await finishJobStage(ctx, 'emailDiscovery', summary);
    return summary;
}

/**
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {string[]} batchDomains
 * @param {{ batchIndex?: number }} [batchOpts]
 */
export async function runEmailsBatch(ctx, batchDomains, batchOpts = {}) {
    const batchIndex = batchOpts.batchIndex ?? 0;
    const jobRow = await getJobById(ctx.jobId, ctx.agencyId);
    const stageLog = createStageLogger(ctx, 'emailDiscovery', {
        label: 'emails',
        batchLocalProgress: true,
        batchIndex
    });

    if (ctx.options.skipEmailFinder) {
        return importCsvEmailsBatch(ctx, batchDomains, { batchIndex, stageLog });
    }

    const reprocessInclude = enrichmentMergeMode(ctx) === 'enrichment_b';
    // Scoped by batch domains in SQL: a global LIMIT window under parallel child
    // runs could starve this batch while work remained for other domains (§5.2).
    const queue = await getEmailFindQueue(ctx.agencyId, ctx.clientId, ctx.jobId, {
        reprocessInclude,
        limit: batchDomains.length + 500,
        jobStartedAt: jobRow?.created_at || null,
        domains: batchDomains
    });

    if (!queue.length) {
        await finishJobStage(ctx, 'emailDiscovery', { processed: 0, cost: 0 });
        return { processed: 0 };
    }

    await beginJobStage(ctx, 'emailDiscovery', {
        activity: `Email discovery (${queue.length} founders)…`,
        batchIndex
    });

    const founders = queue.map((r) => ({
        domain: r.domain,
        founder_name: r.founder_name
    }));

    const job = contextToJob(ctx);

    const summary = await runEmailFinder({
        founders,
        apiKeys: { ...ctx.apiKeys, kitt: ctx.apiKeys.trykitt },
        log: stageLog,
        job,
        checkpoint: () => assertJobActive(ctx.jobId, ctx.agencyId),
        checkPaused: () => assertJobActive(ctx.jobId, ctx.agencyId),
        pricing: ctx.pricing,
        progressOffset: 0,
        progressTotal: null,
        rateLimitHooks: createRateLimitHooks(ctx),
        onBatch: async (rows) => {
            if (!rows?.length) return;
            await upsertLeadRowsBatch({
                agencyId: ctx.agencyId,
                clientId: ctx.clientId,
                rows,
                type: 'emails',
                jobId: ctx.jobId,
                mergeMode: enrichmentMergeMode(ctx),
                reconcileAfterWrite: shouldScheduleChildReconcile(ctx)
            });
        }
    });

    await finishJobStage(ctx, 'emailDiscovery', summary);
    return summary;
}
