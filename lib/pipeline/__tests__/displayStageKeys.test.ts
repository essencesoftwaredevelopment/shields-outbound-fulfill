import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDisplayStageKeys, resolveVisibleStageKeys, type PipelineJob } from '../types.ts';

const stages = {} as PipelineJob['stages'];

describe('resolveDisplayStageKeys', () => {
  it('standard jobs always show the five overview cards, whatever was skipped', () => {
    const job = {
      pipelineMode: 'standard' as const,
      stages,
      skipFounderFinder: true,
      skipEmailFinder: true,
      skipVerification: true,
      personalizeFirstLine: false,
    };
    assert.deepEqual(resolveDisplayStageKeys(job), ['domainPrep', 'founders', 'emailDiscovery', 'verification', 'personalization']);
    // …while the active list (progress / ETA / cost) still drops them.
    assert.deepEqual(resolveVisibleStageKeys(job), ['domainPrep']);
  });

  it('shopping-audit jobs (Vulcan) keep their audit cards and hide personalization unless enabled', () => {
    const audit = {
      pipelineMode: 'shopping_audit' as const,
      stages,
      skipFounderFinder: true,
      skipEmailFinder: true,
      skipVerification: false,
      personalizeFirstLine: false,
    };
    assert.deepEqual(resolveDisplayStageKeys(audit), [
      'domainPrep', 'serperShopping', 'signalWaterfall', 'founders', 'emailDiscovery', 'verification',
    ]);
    assert.deepEqual(resolveDisplayStageKeys({ ...audit, personalizeFirstLine: true }).at(-1), 'personalization');
  });

  it('a null job renders the standard overview', () => {
    assert.equal(resolveDisplayStageKeys(null).length, 5);
  });
});
