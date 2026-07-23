import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkDomains,
  DEFAULT_BATCH_SIZE,
  DEFAULT_SHOPPING_AUDIT_BATCH_SIZE,
  DEFAULT_WAVE_CONCURRENCY,
  resolveBatchSize,
  resolveWaveConcurrency,
} from '../batchPlan.ts';

const ENV_KEYS = [
  'SHOPPING_AUDIT_BATCH_SIZE',
  'ENRICHMENT_BATCH_SIZE',
  'ENRICHMENT_CHILD_WAVE_CONCURRENCY',
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('resolveBatchSize', () => {
  it('defaults per pipeline mode with no job option and no env', () => {
    assert.equal(
      resolveBatchSize('shopping_audit'),
      DEFAULT_SHOPPING_AUDIT_BATCH_SIZE
    );
    assert.equal(resolveBatchSize('standard'), DEFAULT_BATCH_SIZE);
  });

  it('env overrides the default, per-mode env var', () => {
    process.env.SHOPPING_AUDIT_BATCH_SIZE = '50';
    process.env.ENRICHMENT_BATCH_SIZE = '200';
    assert.equal(resolveBatchSize('shopping_audit'), 50);
    assert.equal(resolveBatchSize('standard'), 200);
  });

  it('does not read the other mode’s env var', () => {
    process.env.ENRICHMENT_BATCH_SIZE = '200';
    assert.equal(
      resolveBatchSize('shopping_audit'),
      DEFAULT_SHOPPING_AUDIT_BATCH_SIZE
    );
    process.env.SHOPPING_AUDIT_BATCH_SIZE = '50';
    assert.equal(resolveBatchSize('standard'), 200);
  });

  it('jobs.options.batchSize wins over env and default', () => {
    process.env.SHOPPING_AUDIT_BATCH_SIZE = '50';
    assert.equal(resolveBatchSize('shopping_audit', { batchSize: 10 }), 10);
    assert.equal(resolveBatchSize('standard', { batchSize: 10 }), 10);
  });

  it('accepts numeric strings and floors fractions (JSONB options arrive untyped)', () => {
    assert.equal(resolveBatchSize('shopping_audit', { batchSize: '40' }), 40);
    assert.equal(resolveBatchSize('shopping_audit', { batchSize: 40.9 }), 40);
  });

  it('rejects invalid job options and falls through to env, then default', () => {
    process.env.SHOPPING_AUDIT_BATCH_SIZE = '50';
    for (const bad of [0, -5, 'abc', '', null, undefined, true, {}, [], NaN]) {
      assert.equal(
        resolveBatchSize('shopping_audit', { batchSize: bad }),
        50,
        `expected env fallback for ${JSON.stringify(bad)}`
      );
    }
    delete process.env.SHOPPING_AUDIT_BATCH_SIZE;
    assert.equal(
      resolveBatchSize('shopping_audit', { batchSize: 'abc' }),
      DEFAULT_SHOPPING_AUDIT_BATCH_SIZE
    );
  });

  it('rejects invalid env values and falls through to the default', () => {
    for (const bad of ['0', '-3', 'abc', '']) {
      process.env.SHOPPING_AUDIT_BATCH_SIZE = bad;
      assert.equal(
        resolveBatchSize('shopping_audit'),
        DEFAULT_SHOPPING_AUDIT_BATCH_SIZE,
        `expected default for env ${JSON.stringify(bad)}`
      );
    }
  });

  it('ignores options object without a batchSize key', () => {
    assert.equal(
      resolveBatchSize('shopping_audit', { other: 1 }),
      DEFAULT_SHOPPING_AUDIT_BATCH_SIZE
    );
    assert.equal(resolveBatchSize('shopping_audit', null), DEFAULT_SHOPPING_AUDIT_BATCH_SIZE);
  });
});

describe('resolveWaveConcurrency', () => {
  it('defaults to 5 with no job option and no env', () => {
    assert.equal(resolveWaveConcurrency(), DEFAULT_WAVE_CONCURRENCY);
    assert.equal(resolveWaveConcurrency({}), DEFAULT_WAVE_CONCURRENCY);
  });

  it('env overrides the default', () => {
    process.env.ENRICHMENT_CHILD_WAVE_CONCURRENCY = '8';
    assert.equal(resolveWaveConcurrency(), 8);
  });

  it('jobs.options.waveConcurrency wins over env', () => {
    process.env.ENRICHMENT_CHILD_WAVE_CONCURRENCY = '8';
    assert.equal(resolveWaveConcurrency({ waveConcurrency: 3 }), 3);
    assert.equal(resolveWaveConcurrency({ waveConcurrency: '12' }), 12);
  });

  it('rejects invalid values at each level', () => {
    process.env.ENRICHMENT_CHILD_WAVE_CONCURRENCY = '8';
    assert.equal(resolveWaveConcurrency({ waveConcurrency: 0 }), 8);
    process.env.ENRICHMENT_CHILD_WAVE_CONCURRENCY = 'nope';
    assert.equal(
      resolveWaveConcurrency({ waveConcurrency: -1 }),
      DEFAULT_WAVE_CONCURRENCY
    );
  });
});

describe('chunkDomains', () => {
  it('splits into batchSize chunks with a short tail', () => {
    const domains = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(chunkDomains(domains, 2), [['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('returns no batches for an empty list', () => {
    assert.deepEqual(chunkDomains([], 25), []);
  });
});
