/**
 * TryKitt returns HTTP 402 (Payment Required) for both transient throttling and
 * credit/balance exhaustion. These helpers distinguish the two so the pipeline can
 * PAUSE the job on exhaustion (resumable after top-up) instead of silently marking
 * every lookup "done" with no result.
 */

// Matched against the body of a 402 response only — where "payment"/"credit"/"balance"
// language unambiguously means out-of-funds rather than rate limiting.
const CREDIT_PATTERN =
    /credit|insufficient|balance|payment\s*required|top[\s-]?up|out\s*of\s*credit|no\s*credits|quota|exhaust|not\s*enough|add\s*funds|upgrade|subscription|billing/i;

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

    return candidates.some((c) => CREDIT_PATTERN.test(c));
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
