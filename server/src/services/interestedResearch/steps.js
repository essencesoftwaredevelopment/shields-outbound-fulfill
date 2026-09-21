/**
 * Compact progress stamps for the interested-research workflow UI.
 * Homepage + Serper run in parallel, so they share one "research" step.
 * Keep ids stable — they are stored on interested_autoresponder_drafts.research_step.
 */

export const INTERESTED_RESEARCH_STEPS = Object.freeze([
    Object.freeze({ id: 'hydrate', label: 'Load' }),
    Object.freeze({ id: 'research', label: 'Research' }),
    Object.freeze({ id: 'synthesize', label: 'Brief' }),
    Object.freeze({ id: 'persist', label: 'Save' }),
    Object.freeze({ id: 'size', label: 'Size' }),
    Object.freeze({ id: 'popup', label: 'Preview' }),
    Object.freeze({ id: 'finalize', label: 'Draft' })
]);

const STEP_INDEX = new Map(INTERESTED_RESEARCH_STEPS.map((step, index) => [step.id, index]));

export function isInterestedResearchStepId(value) {
    return STEP_INDEX.has(String(value || ''));
}

/**
 * Map a draft's status + research_step onto the horizontal stepper.
 * Researching with a missing/unknown step highlights the first dot (queued).
 *
 * @param {string | null | undefined} status
 * @param {string | null | undefined} stepId
 * @returns {{ currentIndex: number, complete: boolean, currentId: string | null }}
 */
export function resolveResearchProgress(status, stepId) {
    const steps = INTERESTED_RESEARCH_STEPS;
    if (String(status || '') !== 'researching') {
        return { currentIndex: steps.length - 1, complete: true, currentId: null };
    }
    const id = String(stepId || '');
    const index = STEP_INDEX.has(id) ? Number(STEP_INDEX.get(id)) : 0;
    return { currentIndex: index, complete: false, currentId: steps[index].id };
}
