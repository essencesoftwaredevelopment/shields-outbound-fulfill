/**
 * Completion-hook payload contract between the enrichment child runs and the
 * parent orchestrator. The parent classifies batches ONLY from `status` — never
 * by inspecting errors — so everything the parent needs must be encoded here.
 */

export type ChildCompletionStatus = 'ok' | 'failed' | 'inactive';

export type ChildCompletionSummary = {
  domainCount: number;
  auditSignals: number;
};

export type ChildCompletionError = {
  message: string;
  code: string | null;
};

export type ChildCompletionPayload = {
  batchIndex: number;
  status: ChildCompletionStatus;
  summary?: ChildCompletionSummary;
  error?: ChildCompletionError;
};

const INACTIVE_CODES = new Set(['JOB_PAUSED', 'JOB_CANCELLED']);
/**
 * The workflow platform serializes errors across the step boundary keeping only
 * name/message/stack, so `assertJobActive`'s custom `code` never reaches the
 * child workflow's catch — the exact messages thrown by
 * `server/src/enrichment/persist.js` are the reliable carrier. `code` is still
 * checked first for errors that never crossed a step boundary.
 */
const INACTIVE_MESSAGES = new Set(['Job paused', 'Job cancelled']);

/** Reduce an arbitrary thrown value to the serializable payload error shape. */
export function toChildErrorInfo(err: unknown): ChildCompletionError {
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown };
    return {
      message: typeof e.message === 'string' ? e.message : String(err),
      code: typeof e.code === 'string' ? e.code : null,
    };
  }
  return { message: String(err), code: null };
}

/** `inactive` = assertJobActive rejected (job paused/cancelled mid-batch). */
export function isInactiveError(error: ChildCompletionError): boolean {
  if (error.code !== null && INACTIVE_CODES.has(error.code)) return true;
  return INACTIVE_MESSAGES.has(error.message);
}

/**
 * Classify a child-batch failure into the completion payload. Misclassifying
 * `inactive` as `failed` degrades safely: the parent's next per-wave
 * assertJobActiveStep still stops the run and `handleWorkflowFailure`
 * classifies the terminal state from the authoritative DB flags.
 */
export function buildChildFailurePayload(
  batchIndex: number,
  err: unknown
): ChildCompletionPayload {
  const error = toChildErrorInfo(err);
  return {
    batchIndex,
    status: isInactiveError(error) ? 'inactive' : 'failed',
    error,
  };
}
