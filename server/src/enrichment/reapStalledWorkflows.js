import { pool } from '../config/db.js';
import { finalizeWorkflowError } from './persist.js';

/**
 * Default minutes of no `jobs.updated_at` movement before a running Vercel job is
 * considered stalled. Must exceed the platform per-step maxDuration (config.json sets
 * steps.maxDuration='max' ≈ up to ~13 min on Fluid/Enterprise) so a job legitimately
 * sitting inside one long step is never reaped mid-flight. 20 min leaves headroom.
 */
const DEFAULT_STALL_MINUTES = 20;

function resolveStallMinutes(override) {
    if (Number.isFinite(override) && override > 0) return override;
    const fromEnv = Number.parseInt(process.env.ENRICHMENT_STALL_MINUTES || '', 10);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_STALL_MINUTES;
}

/**
 * Watchdog: find Vercel-runner enrichment jobs stuck at status='running' with no
 * progress, and convert them into a recoverable paused-with-error state.
 *
 * This is the backstop for the case the in-workflow try/catch (handleWorkflowFailure)
 * cannot cover — the workflow process dying before its catch runs (infra eviction, OOM,
 * a lost step delivery). Without it, such a job is an invisible `running` zombie forever.
 *
 * We deliberately do NOT auto-retrigger here: re-starting requires clearing
 * `workflowRunId`, which would double-run a job that is actually alive but merely slow.
 * Flipping to paused-with-error makes the job visible and resumable via the existing
 * resume route (idempotent DB queues reprocess only the still-pending work). Auto-resume
 * can come later once we verify run liveness against the workflow runtime.
 *
 * @param {{ staleMinutes?: number }} [opts]
 * @returns {Promise<{ staleMinutes: number, candidates: number, reaped: string[] }>}
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
        `SELECT id, agency_id
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
        }
    }

    if (reaped.length) {
        console.log(`[reap] recovered ${reaped.length} stalled workflow job(s): ${reaped.join(', ')}`);
    }

    return { staleMinutes: minutes, candidates: rows.length, reaped };
}
