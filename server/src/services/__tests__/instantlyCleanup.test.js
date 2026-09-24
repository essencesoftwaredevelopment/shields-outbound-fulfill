import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { badFitStatusesFromLabels, isInstantlyCleanupSweepEnabled } from '../instantlyCleanup.js';

describe('badFitStatusesFromLabels', () => {
    it('finds the workspace\'s Bad Fit label by name, whatever its number', () => {
        const labels = [
            { label: 'Warm Follow Up', interest_status: 51 },
            { label: 'Call Again in a While', interest_status: -498 },
            { label: 'Bad Fit', interest_status: -499 },
            { label: 'Day 1', interest_status: 52 }
        ];
        assert.deepEqual(badFitStatusesFromLabels(labels), [-499]);
        assert.deepEqual(badFitStatusesFromLabels([{ label: ' bad  fit ', interest_status: -12 }]), [-12]);
    });

    it('returns nothing when the workspace has no Bad Fit label', () => {
        assert.deepEqual(badFitStatusesFromLabels([{ label: 'Warm Follow Up', interest_status: 51 }]), []);
        assert.deepEqual(badFitStatusesFromLabels(null), []);
    });
});

describe('isInstantlyCleanupSweepEnabled', () => {
    it('only sweeps from production by default (dev servers share the prod DB)', () => {
        assert.equal(isInstantlyCleanupSweepEnabled({ NODE_ENV: 'production' }), true);
        assert.equal(isInstantlyCleanupSweepEnabled({ NODE_ENV: 'development' }), false);
        assert.equal(isInstantlyCleanupSweepEnabled({}), false);
    });

    it('honours the explicit override', () => {
        assert.equal(isInstantlyCleanupSweepEnabled({ NODE_ENV: 'production', INSTANTLY_CLEANUP_SWEEP_ENABLED: 'false' }), false);
        assert.equal(isInstantlyCleanupSweepEnabled({ NODE_ENV: 'development', INSTANTLY_CLEANUP_SWEEP_ENABLED: 'true' }), true);
    });
});
