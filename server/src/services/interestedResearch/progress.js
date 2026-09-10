/**
 * UX-only progress stamps for the interested-research workflow.
 * Never fail the research run — a missed update just leaves the stepper
 * on the previous dot until the next step.
 */
import { pool } from '../../config/db.js';
import { isInterestedResearchStepId } from './steps.js';

export async function stampResearchStep(draftId, agencyId, stepId, db = pool) {
    if (!isInterestedResearchStepId(stepId)) return;
    try {
        await db.query(
            `UPDATE interested_autoresponder_drafts
             SET research_step = $3,
                 updated_at = NOW()
             WHERE id = $1 AND agency_id = $2 AND status = 'researching'`,
            [draftId, agencyId, stepId]
        );
    } catch (err) {
        console.warn(
            `[interested-research] stamp step=${stepId} draft=${draftId} failed: ${err?.message || err}`
        );
    }
}

export async function attachWorkflowRunId({ draftId, agencyId, workflowRunId, db = pool }) {
    const runId = String(workflowRunId || '').trim();
    if (!runId) return;
    try {
        await db.query(
            `UPDATE interested_autoresponder_drafts
             SET workflow_run_id = $3,
                 research_step = COALESCE(research_step, 'hydrate'),
                 updated_at = NOW()
             WHERE id = $1 AND agency_id = $2 AND status = 'researching'`,
            [draftId, agencyId, runId]
        );
    } catch (err) {
        console.warn(
            `[interested-research] attach run ${runId} draft=${draftId} failed: ${err?.message || err}`
        );
    }
}
