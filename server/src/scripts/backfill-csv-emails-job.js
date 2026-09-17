/**
 * Backfill "upload included email" jobs that ran on the Vercel workflow runner
 * before the emails stage actually imported CSV emails (it only stamped the
 * stage complete, so only contacts that already had an email went on to
 * verify/personalize).
 *
 * Runs the fixed `runEmailsBatch` CSV import over every non-skipped domain of
 * the job, in workflow-sized chunks, through the normal upsert path (same
 * merge mode + email-collision handling as a live run). Idempotent.
 *
 * A completed job is moved to queued for the import (assertJobActive rejects
 * completed and paused jobs) and left paused when done, so the job shows a
 * Resume button. Resuming re-dispatches the workflow: the verify and
 * personalize queues now see the emails and only the remaining work runs.
 *
 * Usage:
 *   DATABASE_URL=... node src/scripts/backfill-csv-emails-job.js <jobId> <agencyId> [--dry-run]
 */

import { pool } from '../config/db.js';
import { hydrateJobContext } from '../enrichment/hydrate.js';
import { runEmailsBatch, buildCsvEmailRows } from '../enrichment/stages/emailsBatch.js';
import { listJobDomainsForJob } from '../services/db/jobs.js';
import { WORKFLOW_BATCH_SIZE } from '../enrichment/stageProgress.js';

const [jobId, agencyId, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');

if (!jobId || !agencyId) {
    console.error('Usage: node src/scripts/backfill-csv-emails-job.js <jobId> <agencyId> [--dry-run]');
    process.exit(1);
}

async function main() {
    const ctx = await hydrateJobContext(jobId, agencyId);
    if (!ctx.options.skipEmailFinder) {
        throw new Error(`Job ${jobId} did not upload emails (skipEmailFinder=false); nothing to backfill.`);
    }

    const jobDomains = await listJobDomainsForJob(jobId, { emailCohortOnly: true, excludeSkipped: true });
    const rows = buildCsvEmailRows(jobDomains, ctx.options.columnMapping);
    console.log(
        `[backfill] job=${jobId} client=${ctx.clientSlug} dedupe=${ctx.options.dedupeStrategy} ` +
        `emailColumn="${ctx.options.columnMapping?.email || ''}" cohortDomains=${jobDomains.length} ` +
        `rowsWithEmail=${rows.length}${dryRun ? ' (dry run)' : ''}`
    );
    if (dryRun || !rows.length) return;

    const { rows: [before] } = await pool.query(
        `SELECT status, paused, cancelled FROM jobs WHERE id = $1 AND agency_id = $2`,
        [jobId, agencyId]
    );
    if (!before) throw new Error(`Job ${jobId} not found`);
    if (before.status === 'running') {
        throw new Error(`Job ${jobId} is running; pause it or wait for it to finish before backfilling.`);
    }
    if (before.cancelled) {
        throw new Error(`Job ${jobId} is cancelled; the Resume route refuses cancelled jobs, so a backfill would be stranded.`);
    }

    // Same transition the Resume route's recovery path makes for a completed job,
    // minus paused (assertJobActive rejects paused too). Re-paused below.
    await pool.query(
        `UPDATE jobs
            SET status = 'queued', completed_at = NULL, paused = false, updated_at = NOW()
          WHERE id = $1 AND agency_id = $2`,
        [jobId, agencyId]
    );
    console.log(`[backfill] job moved ${before.status}${before.paused ? ' (paused)' : ''} -> queued`);

    const domains = jobDomains.map((r) => r.domain_normalized);
    let imported = 0;
    try {
        for (let i = 0; i < domains.length; i += WORKFLOW_BATCH_SIZE) {
            const batch = domains.slice(i, i + WORKFLOW_BATCH_SIZE);
            const summary = await runEmailsBatch(ctx, batch, { batchIndex: Math.floor(i / WORKFLOW_BATCH_SIZE) });
            imported += summary?.imported ?? 0;
            console.log(`[backfill] ${Math.min(i + batch.length, domains.length)} / ${domains.length} domains, imported=${imported}`);
        }
    } finally {
        await pool.query(
            `UPDATE jobs SET paused = true, paused_at = NOW(), updated_at = NOW() WHERE id = $1 AND agency_id = $2`,
            [jobId, agencyId]
        );
    }
    console.log(`[backfill] done: imported ${imported} emails. Job is paused — press Resume to verify + personalize.`);
}

main()
    .catch((err) => {
        console.error('[backfill] failed:', err);
        process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => {}));
