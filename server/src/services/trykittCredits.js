/**
 * TryKitt returns HTTP 402 (Payment Required) for both transient throttling and
 * credit/balance exhaustion. These helpers distinguish the two so the pipeline can
 * PAUSE the job on exhaustion (resumable after top-up) instead of silently marking
 * every lookup "done" with no result.
 */

// Matched against the body of a 402 response only. Deliberately narrow: TryKitt's
// throttle responses are ALSO 402 and use plan/quota/upgrade vocabulary, so only
// explicit funds language (credit/balance/top-up/funds) counts as exhaustion.
// Misclassifying exhaustion as throttle just pauses with a retry-flavored message;
// misclassifying throttle as exhaustion silently drops every remaining row — so
// when in doubt, prefer the throttle path.
const CREDIT_PATTERN =
    /\bcredits?\b|\bbalance\b|top[\s-]?up|add\s+funds|\bfunds\b/i;

/**
 * @param {unknown} parsed Parsed JSON body of a TryKitt 402 response (may be null).
 * @returns {boolean} true if the body indicates credit/balance exhaustion.
 */
export function isCreditExhaustion(parsed) {
    if (!parsed || typeof parsed !== 'object') return false;

    const candidates = [];
    const push = (v) => {
        if (typeof v === 'string') candidates.push(v);
    };

    push(parsed.message);
    push(parsed.error);
    push(parsed.detail);
    push(parsed.reason);
    push(parsed.code);
    push(parsed.status);
    if (parsed.error && typeof parsed.error === 'object') {
        push(parsed.error.message);
        push(parsed.error.code);
    }
    if (parsed.data && typeof parsed.data === 'object') {
        push(parsed.data.message);
    }

    // Codes arrive as INSUFFICIENT_CREDITS-style tokens; underscores defeat \b.
    return candidates.some((c) => CREDIT_PATTERN.test(c.replace(/_/g, ' ')));
}

/**
 * Build the error that pauses the job. `code='CREDIT_EXHAUSTED'` is recognized by the
 * (PM2) jobPipeline handler and the message carries through the Vercel workflow failure
 * path to `jobs.error`.
 * @param {string} [stage] e.g. 'email discovery' / 'email verification'
 */
export function createCreditExhaustedError(stage = '') {
    const suffix = stage ? ` to finish ${stage}` : '';
    const err = new Error(
        `TryKitt is out of credits — add credits and resume the job${suffix}.`
    );
    err.code = 'CREDIT_EXHAUSTED';
    err.userFacing = true;
    return err;
}

/**
 * Build the error thrown when TryKitt throttled/timed out on rows even after
 * retries. Those rows are left unpersisted (completed_at NULL), so resuming the
 * job retries exactly the skipped set. `retryable` lets the workflow step layer
 * retry instead of failing the batch outright.
 * @param {string} stage e.g. 'email discovery' / 'email verification'
 * @param {number} skipped rows left unprocessed
 * @param {number} total rows attempted in this batch
 */
/**
 * @param {string} stage
 * @param {number} skipped requests left without a verdict
 * @param {number} total
 * @param {{ timedOut?: number | null }} [opts] how many of `skipped` were timeouts
 *        (slow recipient mail servers — rate limits don't help); unknown when omitted.
 */
export function createTryKittThrottledError(stage, skipped, total, { timedOut = null } = {}) {
    const throttled = timedOut === null ? null : Math.max(0, skipped - timedOut);
    let what;
    if (timedOut !== null && throttled === 0) {
        what = `TryKitt timed out on ${skipped} of ${total} ${stage} requests (the recipients' mail servers did not answer in time)`;
    } else if (timedOut) {
        what = `TryKitt throttled ${throttled} and timed out on ${timedOut} of ${total} ${stage} requests`;
    } else {
        what = timedOut === null
            ? `TryKitt throttled or timed out on ${skipped} of ${total} ${stage} requests`
            : `TryKitt throttled ${skipped} of ${total} ${stage} requests`;
    }
    const advice = throttled === 0
        ? ''
        : ` If the account is on the free tier, lower TRYKITT_MAX_CONCURRENT / TRYKITT_RPM_LIMIT or upgrade the plan.`;
    const err = new Error(`${what} — they were left unprocessed; resume the job to retry them.${advice}`);
    err.code = 'TRYKITT_THROTTLED';
    err.userFacing = true;
    err.retryable = true;
    // Split for callers: timeouts are slow recipient mail servers (retrying
    // won't help); throttles say something about TryKitt itself. null = unknown.
    err.skipped = skipped;
    err.timedOut = timedOut;
    err.throttled = throttled;
    return err;
}
