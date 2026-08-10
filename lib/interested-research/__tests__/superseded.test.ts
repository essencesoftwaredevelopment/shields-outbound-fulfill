import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isResearchSupersededError,
  isResearchSupersededResult,
  researchSupersededResult,
  toResearchErrorInfo,
} from '../superseded.ts';

function errWithCode(message: string, code: string, name?: string): Error {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  if (name) e.name = name;
  return e;
}

describe('toResearchErrorInfo', () => {
  it('extracts message, code, and name', () => {
    assert.deepEqual(
      toResearchErrorInfo(
        errWithCode('Draft 1 is cancelled', 'RESEARCH_DRAFT_SUPERSEDED', 'ResearchDraftSupersededError')
      ),
      {
        message: 'Draft 1 is cancelled',
        code: 'RESEARCH_DRAFT_SUPERSEDED',
        name: 'ResearchDraftSupersededError',
      }
    );
  });

  it('yields null code/name when absent', () => {
    assert.deepEqual(toResearchErrorInfo(new Error('boom')), {
      message: 'boom',
      code: null,
      name: 'Error',
    });
  });
});

describe('isResearchSupersededError', () => {
  it('classifies by code when present', () => {
    assert.equal(
      isResearchSupersededError(errWithCode('anything', 'RESEARCH_DRAFT_SUPERSEDED')),
      true
    );
  });

  it('classifies by name when code was stripped (post step-boundary shape)', () => {
    const err = new Error(
      "Draft 540 is 'cancelled', not 'researching' — superseded or cancelled"
    );
    err.name = 'ResearchDraftSupersededError';
    assert.equal(isResearchSupersededError(err), true);
  });

  it('classifies by message markers when only message survives', () => {
    assert.equal(
      isResearchSupersededError(
        new Error("Draft 540 is 'cancelled', not 'researching' — superseded or cancelled")
      ),
      true
    );
    assert.equal(
      isResearchSupersededError(
        new Error('Draft 12 was superseded before research finalize could promote it')
      ),
      true
    );
    assert.equal(
      isResearchSupersededError(new Error('Draft 9 not found for agency abc')),
      true
    );
  });

  it('does not classify unrelated errors', () => {
    assert.equal(isResearchSupersededError(new Error('Serper credits exhausted')), false);
    assert.equal(
      isResearchSupersededError(errWithCode('upstream superseded or cancelled', 'OTHER')),
      false
    );
  });

  it('accepts already-reduced error info', () => {
    assert.equal(
      isResearchSupersededError({
        message: 'x',
        code: 'RESEARCH_DRAFT_SUPERSEDED',
        name: null,
      }),
      true
    );
  });
});

describe('researchSupersededResult', () => {
  it('round-trips the sentinel', () => {
    const result = researchSupersededResult();
    assert.equal(isResearchSupersededResult(result), true);
    assert.equal(isResearchSupersededResult({ status: 'promoted' }), false);
    assert.equal(isResearchSupersededResult(null), false);
  });
});
