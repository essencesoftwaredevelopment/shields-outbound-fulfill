import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrowHandoffLimit } from '../stages/verificationBatch.js';

describe('enrowHandoffLimit', () => {
    it('allows a handful of stuck emails on small batches', () => {
        assert.equal(enrowHandoffLimit(1), 5);
        assert.equal(enrowHandoffLimit(40), 5);
    });

    it('scales to 10% on full batches, so a TryKitt outage still pauses the job', () => {
        assert.equal(enrowHandoffLimit(100), 10);
        assert.equal(enrowHandoffLimit(101), 11);
    });
});
