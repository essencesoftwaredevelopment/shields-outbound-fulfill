import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChildFailurePayload,
  isInactiveError,
  toChildErrorInfo,
} from '../childCompletion.ts';

function errWithCode(message: string, code: string): Error {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e;
}

describe('toChildErrorInfo', () => {
  it('extracts message and code from an Error with code', () => {
    assert.deepEqual(toChildErrorInfo(errWithCode('Job paused', 'JOB_PAUSED')), {
      message: 'Job paused',
      code: 'JOB_PAUSED',
    });
  });

  it('yields null code when absent or not a string', () => {
    assert.deepEqual(toChildErrorInfo(new Error('boom')), {
      message: 'boom',
      code: null,
    });
    const numericCode = new Error('boom') as Error & { code?: unknown };
    numericCode.code = 42;
    assert.equal(toChildErrorInfo(numericCode).code, null);
  });

  it('stringifies non-object throws', () => {
    assert.deepEqual(toChildErrorInfo('plain failure'), {
      message: 'plain failure',
      code: null,
    });
    assert.equal(toChildErrorInfo(undefined).message, 'undefined');
  });
});

describe('isInactiveError / buildChildFailurePayload', () => {
  it('classifies JOB_PAUSED / JOB_CANCELLED codes as inactive', () => {
    for (const code of ['JOB_PAUSED', 'JOB_CANCELLED']) {
      const payload = buildChildFailurePayload(3, errWithCode('anything', code));
      assert.equal(payload.status, 'inactive');
      assert.equal(payload.batchIndex, 3);
      assert.equal(payload.error?.code, code);
    }
  });

  it('classifies the exact assertJobActive messages as inactive when the code was stripped (post step-boundary serialization shape)', () => {
    // The workflow platform serializes Errors keeping only name/message/stack —
    // this is the shape the child workflow actually catches.
    for (const message of ['Job paused', 'Job cancelled']) {
      const payload = buildChildFailurePayload(0, new Error(message));
      assert.equal(payload.status, 'inactive', message);
      assert.deepEqual(payload.error, { message, code: null });
    }
  });

  it('requires an exact message match — containing the phrase is not enough', () => {
    const payload = buildChildFailurePayload(
      1,
      new Error('Upstream Job paused for maintenance')
    );
    assert.equal(payload.status, 'failed');
  });

  it('classifies everything else as failed and preserves the message for jobs.error', () => {
    const payload = buildChildFailurePayload(
      7,
      new Error('Serper credits exhausted')
    );
    assert.deepEqual(payload, {
      batchIndex: 7,
      status: 'failed',
      error: { message: 'Serper credits exhausted', code: null },
    });
  });

  it('treats unknown codes as failed even with an unrelated message', () => {
    assert.equal(
      buildChildFailurePayload(0, errWithCode('Job paused by admin', 'SOMETHING_ELSE'))
        .status,
      'failed'
    );
    assert.equal(isInactiveError({ message: 'other', code: 'OTHER' }), false);
  });
});
