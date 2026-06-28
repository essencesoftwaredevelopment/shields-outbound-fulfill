import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isCreditExhaustion, createCreditExhaustedError } from '../trykittCredits.js';

describe('isCreditExhaustion', () => {
    it('detects common credit/payment phrasings', () => {
        const bodies = [
            { message: 'Insufficient credits' },
            { error: 'Your account is out of credits' },
            { message: 'Payment required to continue' },
            { detail: 'Please top up your balance' },
            { error: { message: 'credit balance exhausted' } },
            { code: 'INSUFFICIENT_CREDITS' },
            { data: { message: 'Add funds to your account' } },
            { reason: 'subscription quota exceeded' },
            { message: 'billing issue: not enough credits' },
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
