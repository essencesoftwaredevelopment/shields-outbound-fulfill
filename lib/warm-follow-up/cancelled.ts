/**
 * Detect a warm-follow-up generation run that moved on while a Vercel
 * workflow step was in flight. Step boundaries keep name/message, not `code`.
 */

export const WARM_FOLLOW_UP_CANCELLED_CODE = 'WARM_FOLLOW_UP_RUN_CANCELLED';
export const WARM_FOLLOW_UP_CANCELLED_NAME = 'WarmFollowUpRunCancelledError';

export type WarmFollowUpCancelledResult = { status: 'cancelled' };

export function warmFollowUpCancelledResult(): WarmFollowUpCancelledResult {
  return { status: 'cancelled' };
}

export function isWarmFollowUpCancelledResult(
  value: unknown
): value is WarmFollowUpCancelledResult {
  return (
    !!value
    && typeof value === 'object'
    && (value as { status?: unknown }).status === 'cancelled'
  );
}

export type WarmFollowUpErrorInfo = {
  message: string;
  code: string | null;
  name: string | null;
};

export function toWarmFollowUpErrorInfo(err: unknown): WarmFollowUpErrorInfo {
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

function looksLikeErrorInfo(value: unknown): value is WarmFollowUpErrorInfo {
  if (!value || typeof value !== 'object') return false;
  if (value instanceof Error) return false;
  const v = value as { message?: unknown; code?: unknown; name?: unknown };
  return typeof v.message === 'string' && ('code' in v || 'name' in v);
}

export function isWarmFollowUpCancelledError(errOrInfo: unknown): boolean {
  const info = looksLikeErrorInfo(errOrInfo)
    ? errOrInfo
    : toWarmFollowUpErrorInfo(errOrInfo);

  if (info.code === WARM_FOLLOW_UP_CANCELLED_CODE) return true;
  if (info.name === WARM_FOLLOW_UP_CANCELLED_NAME) return true;
  const msg = info.message;
  return (
    msg.includes('— cancelled or no longer running')
    || /^Generation run \d+ not found for agency /.test(msg)
  );
}
