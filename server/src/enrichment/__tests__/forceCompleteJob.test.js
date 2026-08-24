import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { markStagesCompletedForForceComplete } from '../persist.js';

describe('markStagesCompletedForForceComplete', () => {
    it('marks running and pending stages completed without dropping summaries', () => {
        const stamped = markStagesCompletedForForceComplete({
            verification: {
                status: 'running',
                summary: { verified: 12 },
                error: 'TryKitt timed out',
                completedAt: null
            },
            serperShopping: { status: 'pending', summary: null, error: null, completedAt: null }
        });
        assert.equal(stamped.verification.status, 'completed');
        assert.equal(stamped.verification.error, null);
        assert.equal(stamped.verification.summary.verified, 12);
        assert.equal(typeof stamped.verification.completedAt, 'string');
        assert.equal(stamped.serperShopping.status, 'completed');
    });

    it('keeps an already-completed timestamp', () => {
        const completedAt = '2026-08-21T17:24:53.192Z';
        const stamped = markStagesCompletedForForceComplete({
            founders: { status: 'completed', completedAt, summary: { found: 10 }, error: null }
        });
        assert.equal(stamped.founders.completedAt, completedAt);
        assert.equal(stamped.founders.status, 'completed');
    });
});
