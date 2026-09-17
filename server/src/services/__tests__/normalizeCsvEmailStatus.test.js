import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCsvEmailStatus } from '../enrichmentCohort.js';

describe('normalizeCsvEmailStatus', () => {
    it('maps common provider labels to the four contacts.email_status values', () => {
        const cases = {
            valid: 'valid', Verified: 'valid', deliverable: 'valid', ok: 'valid',
            risky: 'risky', 'valid-risky': 'risky', 'Catch-All': 'risky', accept_all: 'risky',
            invalid: 'invalid', undeliverable: 'invalid', Bounced: 'invalid',
            unknown: 'unknown', unverified: 'unknown'
        };
        for (const [input, expected] of Object.entries(cases)) {
            assert.equal(normalizeCsvEmailStatus(input), expected, input);
        }
    });

    it('returns null for empty cells and "unknown" for unrecognised labels', () => {
        assert.equal(normalizeCsvEmailStatus(''), null);
        assert.equal(normalizeCsvEmailStatus('   '), null);
        assert.equal(normalizeCsvEmailStatus(null), null);
        assert.equal(normalizeCsvEmailStatus(undefined), null);
        assert.equal(normalizeCsvEmailStatus('pending'), 'unknown');
        assert.equal(normalizeCsvEmailStatus(42), 'unknown');
    });
});
