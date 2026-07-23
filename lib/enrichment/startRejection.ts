/**
 * `guardWorkflowStart` rejections identify a DUPLICATE parent run (double
 * trigger, auto-resume race). The duplicate must end WITHOUT writing job state:
 * routing it through the failure handler would flip the healthy concurrent
 * run's job to paused-with-error, killing that run at its next active-check.
 *
 * Matching is by exact message because a custom error `code` does not survive
 * the workflow step serialization boundary (only name/message/stack do). The
 * canonical strings live in `server/src/enrichment/persist.js`
 * (START_REJECTION_ALREADY_RUNNING / START_REJECTION_ALREADY_COMPLETED); a
 * unit test pins both copies in sync.
 */
const START_REJECTION_MESSAGES = new Set([
  'Job already running on Vercel Workflows',
  'Job already completed',
]);

const START_REJECTION_CODES = new Set([
  'WORKFLOW_ALREADY_RUNNING',
  'WORKFLOW_ALREADY_COMPLETED',
]);

export function isStartRejection(error: {
  message: string;
  code: string | null;
}): boolean {
  if (error.code !== null && START_REJECTION_CODES.has(error.code)) return true;
  return START_REJECTION_MESSAGES.has(error.message);
}

/** Exposed for the sync test against persist.js — not for production use. */
export const __startRejectionMessages = [...START_REJECTION_MESSAGES];
