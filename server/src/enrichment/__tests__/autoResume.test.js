import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveAutoResumeDecision,
    MAX_AUTO_RESUME_ATTEMPTS
} from '../reapStalledWorkflows.js';

describe('resolveAutoResumeDecision', () => {
    it('resumes a first-time stall with remaining work', () => {
        assert.deepEqual(
            resolveAutoResumeDecision({ attempts: 0, hasRemainingWork: true }),
            { resume: true, attempts: 0, reason: 'resume' }
        );
        assert.deepEqual(
            resolveAutoResumeDecision({ attempts: undefined, hasRemainingWork: true }),
            { resume: true, attempts: 0, reason: 'resume' }
        );
    });

    it('resumes up to the attempt budget, then leaves the job for a human', () => {
        assert.equal(
            resolveAutoResumeDecision({ attempts: MAX_AUTO_RESUME_ATTEMPTS - 1, hasRemainingWork: true }).resume,
            true
        );
        assert.deepEqual(
            resolveAutoResumeDecision({ attempts: MAX_AUTO_RESUME_ATTEMPTS, hasRemainingWork: true }),
            { resume: false, attempts: MAX_AUTO_RESUME_ATTEMPTS, reason: 'attempts_exhausted' }
        );
        assert.equal(
            resolveAutoResumeDecision({ attempts: MAX_AUTO_RESUME_ATTEMPTS + 5, hasRemainingWork: true }).resume,
            false
        );
    });

    it('never resumes when no pipeline work remains', () => {
        assert.deepEqual(
            resolveAutoResumeDecision({ attempts: 0, hasRemainingWork: false }),
            { resume: false, attempts: 0, reason: 'no_remaining_work' }
        );
    });

    it('treats garbage attempt counters as zero (options JSONB is untyped)', () => {
        for (const attempts of ['abc', null, {}, [], -3, NaN]) {
            const decision = resolveAutoResumeDecision({ attempts, hasRemainingWork: true });
            assert.deepEqual(decision, { resume: true, attempts: 0, reason: 'resume' }, String(attempts));
        }
        // Numeric strings from JSONB round-trips still count.
        assert.equal(
            resolveAutoResumeDecision({ attempts: '2', hasRemainingWork: true }).resume,
            false
        );
    });

    it('the budget itself is 2 per the agreed plan (C2)', () => {
        assert.equal(MAX_AUTO_RESUME_ATTEMPTS, 2);
    });
});
