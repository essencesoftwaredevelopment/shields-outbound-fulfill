import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    isCreditExhaustion,
    createCreditExhaustedError,
    createTryKittThrottledError
} from '../trykittCredits.js';

describe('isCreditExhaustion', () => {
    it('detects explicit funds/credit phrasings', () => {
        const bodies = [
            { message: 'Insufficient credits' },
            { error: 'Your account is out of credits' },
            { detail: 'Please top up your balance' },
            { error: { message: 'credit balance exhausted' } },
            { code: 'INSUFFICIENT_CREDITS' },
            { data: { message: 'Add funds to your account' } },
            { message: 'billing issue: not enough credits' },
            { message: 'You have 0 credits remaining' },
        ];
        for (const b of bodies) {
            assert.equal(isCreditExhaustion(b), true, `should detect: ${JSON.stringify(b)}`);
        }
    });

    it('does not flag unrelated 402 bodies as credit exhaustion', () => {
        const bodies = [
            { message: 'too many requests, slow down' },
            { error: 'temporarily unavailable' },
            { message: 'invalid email format' },
            null,
            undefined,
            'a string, not an object',
            {},
        ];
        for (const b of bodies) {
            assert.equal(isCreditExhaustion(b), false, `should NOT detect: ${JSON.stringify(b)}`);
        }
    });

    it('treats plan/quota/throttle vocabulary as NOT credit exhaustion', () => {
        // TryKitt throttles with 402s that use plan/quota language. Classifying a
        // throttle as exhaustion silently drops the rest of the batch, so these
        // must fall through to the transient (retry-on-resume) path.
        const bodies = [
            { message: 'Payment required to continue' },
            { reason: 'subscription quota exceeded' },
            { message: 'concurrency limit reached, upgrade your plan' },
            { error: 'quota exhausted for this billing period' },
        ];
        for (const b of bodies) {
            assert.equal(isCreditExhaustion(b), false, `should NOT detect: ${JSON.stringify(b)}`);
        }
    });
});

describe('createCreditExhaustedError', () => {
    it('carries the CREDIT_EXHAUSTED code and a resumable, user-facing message', () => {
        const err = createCreditExhaustedError('email discovery');
        assert.equal(err.code, 'CREDIT_EXHAUSTED');
        assert.equal(err.userFacing, true);
        assert.match(err.message, /out of credits/i);
        assert.match(err.message, /resume/i);
        assert.match(err.message, /email discovery/);
    });

    it('works without a stage label', () => {
        const err = createCreditExhaustedError();
        assert.equal(err.code, 'CREDIT_EXHAUSTED');
        assert.match(err.message, /out of credits/i);
    });
});

describe('createTryKittThrottledError', () => {
    it('is retryable, user-facing, and reports the skipped count', () => {
        const err = createTryKittThrottledError('email verification', 30, 200);
        assert.equal(err.code, 'TRYKITT_THROTTLED');
        assert.equal(err.retryable, true);
        assert.equal(err.userFacing, true);
        assert.match(err.message, /30 of 200/);
        assert.match(err.message, /email verification/);
        assert.match(err.message, /resume/i);
    });

    it('says "timed out" and skips the rate-limit advice when nothing was throttled', () => {
        const err = createTryKittThrottledError('email verification', 9, 9, { timedOut: 9 });
        assert.equal(err.code, 'TRYKITT_THROTTLED');
        assert.match(err.message, /timed out on 9 of 9 email verification requests/);
        assert.doesNotMatch(err.message, /throttled/);
        assert.doesNotMatch(err.message, /TRYKITT_MAX_CONCURRENT/);
    });

    it('exposes the timed-out / throttled split for the Enrow hand-off', () => {
        const allTimeouts = createTryKittThrottledError('email verification', 6, 7, { timedOut: 6 });
        assert.equal(allTimeouts.timedOut, 6);
        assert.equal(allTimeouts.throttled, 0);
        const mixed = createTryKittThrottledError('email verification', 12, 100, { timedOut: 5 });
        assert.equal(mixed.throttled, 7);
        const legacy = createTryKittThrottledError('email discovery', 3, 10);
        assert.equal(legacy.throttled, null);
    });

    it('splits throttled from timed-out and keeps the rate-limit advice', () => {
        const err = createTryKittThrottledError('email verification', 12, 100, { timedOut: 5 });
        assert.match(err.message, /throttled 7 and timed out on 5 of 100/);
        assert.match(err.message, /TRYKITT_MAX_CONCURRENT/);
    });
});
