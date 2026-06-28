import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkflowFailureDisposition } from '../finalize.js';

describe('resolveWorkflowFailureDisposition', () => {
    it('defaults to error when nothing indicates a graceful stop', () => {
        assert.equal(resolveWorkflowFailureDisposition({}, null), 'error');
        assert.equal(
            resolveWorkflowFailureDisposition({ cancelled: false, paused: false }, null),
            'error'
        );
    });

    it('treats a real error whose code was lost across the step boundary as error', () => {
        // A thrown Error's `.code` may not survive serialization out of a workflow step;
        // with no DB flag set, this must still resolve to a recoverable error state.
        assert.equal(resolveWorkflowFailureDisposition({}, null), 'error');
    });

    it('resolves cancellation from the DB flag even without a code', () => {
        assert.equal(resolveWorkflowFailureDisposition({ cancelled: true }, null), 'cancelled');
    });

    it('resolves cancellation from the error code even without the DB flag', () => {
        assert.equal(resolveWorkflowFailureDisposition({}, 'JOB_CANCELLED'), 'cancelled');
    });

    it('resolves a user pause from the DB flag (the authoritative signal)', () => {
        // A real error never sets jobs.paused, so a truthy paused flag means a graceful pause.
        assert.equal(resolveWorkflowFailureDisposition({ paused: true }, null), 'paused');
    });

    it('resolves a user pause from the error code even without the DB flag', () => {
        assert.equal(resolveWorkflowFailureDisposition({}, 'JOB_PAUSED'), 'paused');
    });

    it('prefers cancellation over pause when both are present', () => {
        assert.equal(
            resolveWorkflowFailureDisposition({ cancelled: true, paused: true }, null),
            'cancelled'
        );
        assert.equal(resolveWorkflowFailureDisposition({ paused: true }, 'JOB_CANCELLED'), 'cancelled');
    });

    it('tolerates missing/garbage arguments', () => {
        assert.equal(resolveWorkflowFailureDisposition(), 'error');
        assert.equal(resolveWorkflowFailureDisposition(undefined, undefined), 'error');
    });
});
