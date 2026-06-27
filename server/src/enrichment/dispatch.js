import { pool } from '../config/db.js';
import { enqueuePipelineJob, setQueueStatus } from '../services/jobQueue.js';
import { resolveExecutionRunner, withExecutionRunner } from './executionRunner.js';
import { triggerEnrichmentWorkflow } from './trigger.js';

export async function persistExecutionRunner(jobId, runner) {
    await pool.query(
        `UPDATE jobs SET options = COALESCE(options, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
         WHERE id = $1`,
        [jobId, JSON.stringify({ executionRunner: runner })]
    );
}

/**
 * Route a newly created or resumed job to PM2 or Vercel Workflows.
 */
export async function dispatchEnrichmentJob({
    jobId,
    uid,
    clientId,
    payload,
    settings
}) {
    const runner = resolveExecutionRunner({ settings, jobOptions: payload });
    const queuePayload = withExecutionRunner(payload, runner);

    await persistExecutionRunner(jobId, runner);
    await enqueuePipelineJob({
        jobId,
        uid,
        clientId,
        payload: queuePayload
    });

    if (runner === 'vercel') {
        await setQueueStatus(jobId, 'running');
        await triggerEnrichmentWorkflow({ jobId, agencyId: uid });
        return { runner: 'vercel' };
    }

    return { runner: 'pm2' };
}
