/** Detect TryKitt credit-exhaustion pauses so the UI can keep a resumable notice. */

export const TRYKITT_CREDITS_URL = "https://trykitt.ai";

const CREDIT_EXHAUSTION_PATTERN =
  /out of credits|add credits to trykitt|credit.?exhaust/i;

export function isCreditExhaustionText(value: unknown): boolean {
  return typeof value === "string" && CREDIT_EXHAUSTION_PATTERN.test(value);
}

export type CreditExhaustionJobLike = {
  paused?: boolean;
  status?: string;
  error?: string | null;
  activityMessage?: string | null;
  stages?: Record<string, { error?: string | null } | undefined> | null;
};

/** True when a job row carries a TryKitt out-of-credits message. */
export function isCreditExhaustedJob(job: CreditExhaustionJobLike | null | undefined): boolean {
  if (!job) return false;
  if (isCreditExhaustionText(job.error) || isCreditExhaustionText(job.activityMessage)) {
    return true;
  }
  if (!job.stages) return false;
  return Object.values(job.stages).some((stage) => isCreditExhaustionText(stage?.error));
}

/**
 * Show the persistent notice while the job is still recoverable (paused),
 * not after cancel/complete.
 */
export function shouldShowCreditExhaustionNotice(
  job: CreditExhaustionJobLike | null | undefined
): boolean {
  if (!job || !isCreditExhaustedJob(job)) return false;
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return false;
  }
  return job.paused === true;
}
