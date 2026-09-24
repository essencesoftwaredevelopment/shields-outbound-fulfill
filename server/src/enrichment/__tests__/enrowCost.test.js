import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrowBatchCost } from '../stages/enrowBatch.js';

describe('enrowBatchCost', () => {
    it('bills 1 credit per email found at $0.012 a credit', () => {
        assert.equal(enrowBatchCost('find', 1, null), 0.012);
        // 76 found (incl. a duplicate we skip) — matches Enrow's credits_final of 76.
        assert.equal(enrowBatchCost('find', 76, null), 0.912);
    });

    it('bills 0.25 credit per verification', () => {
        assert.equal(enrowBatchCost('verify', 1, null), 0.003);
        // 9,494 verifications = 2,373.5 credits, as Enrow reported.
        assert.equal(enrowBatchCost('verify', 9494, null), 28.482);
    });

    it('costs nothing without billable units', () => {
        assert.equal(enrowBatchCost('find', 0, null), 0);
        assert.equal(enrowBatchCost('verify', -3, null), 0);
    });

    it('honours agency pricing overrides', () => {
        const pricing = { stages: { enrow: { credit_usd: 0.02 } } };
        assert.equal(enrowBatchCost('find', 10, pricing), 0.2);
        assert.equal(enrowBatchCost('verify', 10, pricing), 0.05);
    });
});
