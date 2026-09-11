/**
 * Compact progress stamps for the warm-follow-up Vercel workflow UI.
 * Keep ids stable — they are stored on follow_up_generation_runs.generation_step.
 */

export const WARM_FOLLOW_UP_STEPS = Object.freeze([
    Object.freeze({ id: 'hydrate', label: 'Load' }),
    Object.freeze({ id: 'brief', label: 'Brief' }),
    Object.freeze({ id: 'generate', label: 'Write' }),
    Object.freeze({ id: 'send', label: 'Send' })
]);

export const WARM_FOLLOW_UP_PREVIEW_STEPS = Object.freeze(
    WARM_FOLLOW_UP_STEPS.filter((step) => step.id !== 'send')
);

const STEP_INDEX = new Map(WARM_FOLLOW_UP_STEPS.map((step, index) => [step.id, index]));

export function isWarmFollowUpStepId(value) {
    return STEP_INDEX.has(String(value || ''));
}

/**
 * Map a generation run's status + step onto the horizontal stepper.
 *
 * @param {string | null | undefined} status
 * @param {string | null | undefined} stepId
 * @param {'preview' | 'send'} [mode]
 */
export function resolveWarmFollowUpProgress(status, stepId, mode = 'preview') {
    const steps = mode === 'send' ? WARM_FOLLOW_UP_STEPS : WARM_FOLLOW_UP_PREVIEW_STEPS;
    const normalized = String(status || '');
    if (normalized === 'completed' || normalized === 'failed') {
        return { currentIndex: steps.length - 1, complete: true, currentId: null };
    }
    const id = String(stepId || '');
    const index = STEP_INDEX.has(id) ? Number(STEP_INDEX.get(id)) : 0;
    const clamped = Math.min(index, steps.length - 1);
    return { currentIndex: clamped, complete: false, currentId: steps[clamped].id };
}
