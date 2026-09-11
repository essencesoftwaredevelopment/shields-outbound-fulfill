/**
 * UX-only progress stamps for the warm-follow-up workflow.
 * Never fail the run — a missed update just leaves the stepper on the
 * previous dot until the next step.
 */
import { pool } from '../../config/db.js';
import { isWarmFollowUpStepId } from './steps.js';

export async function stampGenerationStep(runId, agencyId, stepId, db = pool) {
    if (!isWarmFollowUpStepId(stepId)) return;
    try {
        await db.query(
            `UPDATE follow_up_generation_runs
             SET generation_step = $3,
                 updated_at = NOW()
             WHERE id = $1 AND agency_id = $2 AND status = 'running'`,
            [runId, agencyId, stepId]
        );
    } catch (err) {
        console.warn(
            `[warm-follow-up] stamp step=${stepId} run=${runId} failed: ${err?.message || err}`
        );
    }
}

export async function attachWorkflowRunId({ runId, agencyId, workflowRunId, db = pool }) {
    const vercelRunId = String(workflowRunId || '').trim();
    if (!runId || !vercelRunId) return;
    try {
        await db.query(
            `UPDATE follow_up_generation_runs
             SET workflow_run_id = $3,
                 generation_step = COALESCE(generation_step, 'hydrate'),
                 updated_at = NOW()
             WHERE id = $1 AND agency_id = $2 AND status = 'running'`,
            [runId, agencyId, vercelRunId]
        );
    } catch (err) {
        console.warn(
            `[warm-follow-up] attach run ${vercelRunId} run=${runId} failed: ${err?.message || err}`
        );
    }
}
