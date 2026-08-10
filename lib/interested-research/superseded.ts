/**
 * Detect a research draft that was cancelled / superseded while a run was
 * in flight. The workflow platform serializes Errors across the step boundary
 * keeping only name/message/stack — custom `code` is stripped — so detection
 * must use name + stable message markers the same way enrichment classifies
 * JOB_PAUSED / JOB_CANCELLED (see lib/enrichment/childCompletion.ts).
 */

export const RESEARCH_DRAFT_SUPERSEDED_CODE = 'RESEARCH_DRAFT_SUPERSEDED';
export const RESEARCH_DRAFT_SUPERSEDED_NAME = 'ResearchDraftSupersededError';

/** Compact serializable sentinel steps return instead of throwing. */
export type ResearchSupersededResult = { status: 'superseded' };

export function researchSupersededResult(): ResearchSupersededResult {
  return { status: 'superseded' };
}

export function isResearchSupersededResult(
  value: unknown
): value is ResearchSupersededResult {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { status?: unknown }).status === 'superseded'
  );
}

export type ResearchErrorInfo = {
  message: string;
  code: string | null;
  name: string | null;
};

export function toResearchErrorInfo(err: unknown): ResearchErrorInfo {
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown; name?: unknown };
    return {
      message: typeof e.message === 'string' ? e.message : String(err),
      code: typeof e.code === 'string' ? e.code : null,
      name: typeof e.name === 'string' ? e.name : null,
    };
  }
  return { message: String(err), code: null, name: null };
}

function looksLikeErrorInfo(value: unknown): value is ResearchErrorInfo {
  if (!value || typeof value !== 'object') return false;
  if (value instanceof Error) return false;
  const v = value as { message?: unknown; code?: unknown; name?: unknown };
  return typeof v.message === 'string' && ('code' in v || 'name' in v);
}

/**
 * True when a thrown value (raw Error or already-reduced info) means "stop
 * cleanly — draft moved on". Prefer this over checking `code` alone.
 */
export function isResearchSupersededError(errOrInfo: unknown): boolean {
  const info = looksLikeErrorInfo(errOrInfo)
    ? errOrInfo
    : toResearchErrorInfo(errOrInfo);

  if (info.code === RESEARCH_DRAFT_SUPERSEDED_CODE) return true;
  if (info.name === RESEARCH_DRAFT_SUPERSEDED_NAME) return true;
  // Message markers survive step-boundary serialization when code/name do not.
  const msg = info.message;
  return (
    msg.includes('— superseded or cancelled') ||
    msg.includes('was superseded before research finalize') ||
    /^Draft \d+ not found for agency /.test(msg)
  );
}
