import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldScheduleChildReconcile } from '../reconcilePolicy.js';

describe('shouldScheduleChildReconcile', () => {
    it('suppresses reconciliation in Vercel child isolates', () => {
        assert.equal(
            shouldScheduleChildReconcile({
                options: { executionRunner: 'vercel' }
            }),
            false
        );
    });

    it('keeps live reconciliation for PM2 jobs', () => {
        assert.equal(
            shouldScheduleChildReconcile({
                options: { executionRunner: 'pm2' }
            }),
            true
        );
    });

    it('preserves the legacy PM2 default when no runner is present', () => {
        assert.equal(shouldScheduleChildReconcile({ options: {} }), true);
        assert.equal(shouldScheduleChildReconcile({}), true);
    });
});
