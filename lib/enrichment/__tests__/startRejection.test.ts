import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isStartRejection, __startRejectionMessages } from '../startRejection.ts';
import {
  START_REJECTION_ALREADY_RUNNING,
  START_REJECTION_ALREADY_COMPLETED,
} from '../../../server/src/enrichment/persist.js';

describe('isStartRejection', () => {
  it('matches the exact guard messages (post step-boundary shape: code stripped)', () => {
    assert.equal(
      isStartRejection({ message: 'Job already running on Vercel Workflows', code: null }),
      true
    );
    assert.equal(isStartRejection({ message: 'Job already completed', code: null }), true);
  });

  it('matches by code when the error never crossed a step boundary', () => {
    assert.equal(
      isStartRejection({ message: 'anything', code: 'WORKFLOW_ALREADY_RUNNING' }),
      true
    );
    assert.equal(
      isStartRejection({ message: 'anything', code: 'WORKFLOW_ALREADY_COMPLETED' }),
      true
    );
  });

  it('does not match ordinary failures or near-miss messages', () => {
    assert.equal(isStartRejection({ message: 'Job not found', code: null }), false);
    assert.equal(isStartRejection({ message: 'Serper credits exhausted', code: null }), false);
    assert.equal(
      isStartRejection({ message: 'Job already running on Vercel Workflows!', code: null }),
      false
    );
    assert.equal(isStartRejection({ message: 'Job paused', code: 'JOB_PAUSED' }), false);
  });

  it('stays in sync with the canonical messages thrown by guardWorkflowStart (persist.js)', () => {
    // The parent matches these EXACT strings after serialization strips the code;
    // if persist.js rewords a guard rejection, this test must fail.
    assert.deepEqual(
      [...__startRejectionMessages].sort(),
      [START_REJECTION_ALREADY_RUNNING, START_REJECTION_ALREADY_COMPLETED].sort()
    );
  });
});
