import { pool } from '../config/db.js';
import { jobHasRemainingPipelineWork } from '../services/db/jobs.js';
import { setQueueStatus } from '../services/jobQueue.js';
import { finalizeWorkflowError, clearWorkflowRunId } from './persist.js';
import { triggerEnrichmentWorkflow } from './trigger.js';

/**
 * Default minutes of no `jobs.updated_at` movement before a running Vercel job is
 * considered stalled. Must exceed the platform per-step maxDuration (config.json sets
 * steps.maxDuration='max' ≈ up to ~13 min on Fluid/Enterprise) so a job legitimately
 * sitting inside one long step is never reaped mid-flight. 20 min leaves headroom.
 */
const DEFAULT_STALL_MINUTES = 20;

/** Auto-resume budget per successful finalize (C2): after this, a human decides. */
export const MAX_AUTO_RESUME_ATTEMPTS = 2;

function resolveStallMinutes(override) {
    if (Number.isFinite(override) && override > 0) return override;
    const fromEnv = Number.parseInt(process.env.ENRICHMENT_STALL_MINUTES || '', 10);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_STALL_MINUTES;
}

/**
 * Pure decision: should a just-reaped job be auto-resumed?
 *
 * @param {{ attempts?: unknown, hasRemainingWork?: boolean }} input
 * @returns {{ resume: boolean, attempts: number, reason: 'resume' | 'no_remaining_work' | 'attempts_exhausted' }}
 */
export function resolveAutoResumeDecision({ attempts, hasRemainingWork } = {}) {
    const used = Number.isFinite(Number(attempts)) && Number(attempts) > 0
        ? Math.floor(Number(attempts))
        : 0;
    if (used >= MAX_AUTO_RESUME_ATTEMPTS) {
        return { resume: false, attempts: used, reason: 'attempts_exhausted' };
    }
    if (!hasRemainingWork) {
        return { resume: false, attempts: used, reason: 'no_remaining_work' };
    }
    return { resume: true, attempts: used, reason: 'resume' };
}

/**
 * Auto-resume one just-reaped job (C2): bump the attempt counter, flip the job
 * back to running, and re-trigger the workflow start route (which clears the
 * stale run id before starting the new parent run). The counter is written
 * BEFORE triggering so a crash mid-resume can never grant unlimited attempts;
 * `finalizeJobSuccess` resets it. If the trigger fails, the job is put back to
 * paused-with-error so the manual resume path still works.
 */
async function autoResumeReapedJob(row) {
    const options = row.options || {};
    const decision = resolveAutoResumeDecision({
        attempts: options.autoResumeAttempts,
        hasRemainingWork: await jobHasRemainingPipelineWork({
            agencyId: row.agency_id,
            clientId: row.client_id,
            jobId: row.id,
            skipEmailFinder: !!options.skipEmailFinder,
            skipVerification: !!options.skipVerification,
            personalizeFirstLine: !!options.personalizeFirstLine,
            dedupeStrategy: options.dedupeStrategy || 'skip',
            jobStartedAt: row.created_at ? new Date(row.created_at).toISOString() : null
        })
    });

    if (!decision.resume) {
        console.log(
            `[reap] job ${row.id} left paused-with-error (${decision.reason}, attempts=${decision.attempts}/${MAX_AUTO_RESUME_ATTEMPTS})`
        );
        return false;
    }

    const attempt = decision.attempts + 1;
    await pool.query(
        `UPDATE jobs SET
            status = 'running',
            paused = false,
            cancelled = false,
            error = NULL,
            resumed_at = NOW(),
            options = COALESCE(options, '{}'::jsonb) || $3::jsonb,
            updated_at = NOW()
         WHERE id = $1 AND agency_id = $2`,
        [
            row.id,
            row.agency_id,
            JSON.stringify({
                autoResumeAttempts: attempt,
                activityMessage: `Auto-resuming after stall (attempt ${attempt}/${MAX_AUTO_RESUME_ATTEMPTS})…`,
                activityUpdatedAt: new Date().toISOString()
            })
        ]
    );
    await setQueueStatus(row.id, 'running');
    await clearWorkflowRunId(row.id);

    try {
        await triggerEnrichmentWorkflow({ jobId: row.id, agencyId: row.agency_id });
    } catch (err) {
        // Put the job back into the recoverable state the reap just created, so
        // the manual resume route (and the next reap pass) still work.
        await finalizeWorkflowError(
            row.id,
            row.agency_id,
            `Auto-resume failed (attempt ${attempt}/${MAX_AUTO_RESUME_ATTEMPTS}): ${err?.message || err}. Resume manually to continue.`
        );
        throw err;
    }

    console.log(`[reap] auto-resumed job ${row.id} (attempt ${attempt}/${MAX_AUTO_RESUME_ATTEMPTS})`);
    return true;
}

/**
 * Watchdog: find Vercel-runner enrichment jobs stuck at status='running' with no
 * progress, and convert them into a recoverable paused-with-error state — then
 * auto-resume them (max MAX_AUTO_RESUME_ATTEMPTS per successful finalize) when
 * pipeline queues still hold work.
 *
 * This is the backstop for the case the in-workflow try/catch (handleWorkflowFailure)
 * cannot cover — the workflow process dying before its catch runs (infra eviction, OOM,
 * a lost step delivery). Without it, such a job is an invisible `running` zombie forever.
 *
 * Auto-resume safety rests on three things: the liveness check below biases hard
 * toward under-reaping (only jobs with NO recent DB activity and NO recent API
 * events are touched); `guardWorkflowStart` rejects a duplicate parent run
 * without touching job state (the parent classifies that rejection and exits
 * cleanly); and Phase 2/3 idempotency means a re-run never re-charges paid APIs
 * for already-processed work. After the attempt budget is exhausted the job
 * stays paused-with-error for a human.
 *
 * @param {{ staleMinutes?: number }} [opts]
 * @returns {Promise<{ staleMinutes: number, candidates: number, reaped: string[], autoResumed: string[] }>}
 */
export async function reapStalledWorkflows({ staleMinutes } = {}) {
    const minutes = resolveStallMinutes(staleMinutes);

    // `updated_at` alone is NOT a reliable liveness signal: it only advances on batch
    // completion / reconcile, so a healthy but rate-limited stage (e.g. TryKitt at 60 RPM)
    // can sit still for many minutes. Before reaping, require ALSO that the agency has made
    // no external API call recently — api_rate_limit_events is written on every founders/
    // emails/verify call and self-prunes to a ~1-minute window, so "no event in 90s" means
    // genuinely no API activity. This biases toward under-reaping (the in-workflow catch is
    // the primary recovery; this is only the backstop for a process that died silently).
    const { rows } = await pool.query(
        `SELECT id, agency_id, client_id, options, created_at
           FROM jobs
          WHERE status = 'running'
            AND COALESCE(options->>'executionRunner', 'pm2') = 'vercel'
            AND COALESCE(paused, false) = false
            AND COALESCE(cancelled, false) = false
            AND options ? 'workflowRunId'
            AND updated_at < NOW() - make_interval(mins => $1)
            AND NOT EXISTS (
                SELECT 1 FROM api_rate_limit_events e
                WHERE e.scope_key LIKE jobs.agency_id || ':%'
                  AND e.requested_at > NOW() - INTERVAL '90 seconds'
            )`,
        [minutes]
    );

    const reaped = [];
    const autoResumed = [];
    for (const row of rows) {
        try {
            await finalizeWorkflowError(
                row.id,
                row.agency_id,
                `Stalled — no workflow progress for ${minutes}+ minutes. Resume to continue.`
            );
            reaped.push(row.id);
        } catch (err) {
            // Don't let one bad row abort the sweep — the next cron tick retries it.
            console.warn(`[reap] failed to reap job ${row.id}:`, err?.message || err);
            continue;
        }

        try {
            if (await autoResumeReapedJob(row)) {
                autoResumed.push(row.id);
            }
        } catch (err) {
            // Job is back in paused-with-error (see autoResumeReapedJob) — recoverable.
            console.warn(`[reap] auto-resume failed for job ${row.id}:`, err?.message || err);
        }
    }

    if (reaped.length) {
        console.log(
            `[reap] recovered ${reaped.length} stalled workflow job(s): ${reaped.join(', ')}` +
            (autoResumed.length ? ` — auto-resumed: ${autoResumed.join(', ')}` : '')
        );
    }

    return { staleMinutes: minutes, candidates: rows.length, reaped, autoResumed };
}
