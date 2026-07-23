import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stageCountsToStages, type JobStageCounts } from '../stageCounts.ts';

/** RPC payload shape of the 500-domain shopping-audit validation job
 *  (1784821631329-6w6v5g): 110 matched → 110 signals → 110 checked,
 *  54 valid + 33 risky + 18 invalid + 5 unknown. */
function shoppingAuditCounts(): JobStageCounts {
  return {
    jobId: 'test-job',
    pipelineMode: 'shopping_audit',
    domainPrep: {
      total: 500,
      pending: 0,
      processing: 0,
      done: 110,
      skipped: 390,
      processable: 500,
      dns: { checked: 500, live: 81, dead: 0, unknown: 419, skipped: 0 },
    },
    serperShopping: { processed: 500, matched: 110, none: 390 },
    signalWaterfall: { signals: 110, done: 110, skipped: 390, pending: 0 },
    founders: { processed: 110, found: 110 },
    emailDiscovery: { processed: 500, found: 500 },
    verification: { verified: 110, valid: 54, invalid: 18, unknown: 5, validRisky: 33 },
    personalization: { processed: 0, personalized: 0 },
    contacts: { total: 500 },
  };
}

describe('stageCountsToStages (shopping audit)', () => {
  it('keeps the real emission count in signalWaterfall.summary.signals — never the domains-through-waterfall count', () => {
    const stages = stageCountsToStages(shoppingAuditCounts(), null, { jobRunning: true });
    // processed (progress denominator semantics) counts every domain the
    // waterfall dispositioned (done + skipped); the card must render signals.
    assert.equal(stages.signalWaterfall?.summary?.signals, 110);
    assert.equal(stages.signalWaterfall?.summary?.processed, 500);
    assert.equal(stages.signalWaterfall?.progress?.stats?.signals, 110);
  });

  it('exposes the verification outcome split the card derives its hero from (safe + risky)', () => {
    const stages = stageCountsToStages(shoppingAuditCounts(), null, { jobRunning: true });
    const summary = stages.verification?.summary as Record<string, unknown>;
    assert.equal(summary?.valid, 54);
    assert.equal(summary?.['valid-risky'], 33);
    assert.equal(summary?.processed, 110); // "checked"
  });

  it('marks every stage completed once the job is completed, overriding count math', () => {
    // Without the override, verification (110 checked vs 500-contact denominator)
    // stays "running" forever on a completed shopping audit — the phantom-ETA bug.
    const running = stageCountsToStages(shoppingAuditCounts(), null, { jobRunning: true });
    assert.equal(running.verification?.status, 'running');

    const completed = stageCountsToStages(shoppingAuditCounts(), null, {
      jobRunning: false,
      jobCompleted: true,
    });
    for (const [key, stage] of Object.entries(completed)) {
      assert.equal(stage?.status, 'completed', `stage ${key} should be completed`);
    }
  });

  it('a completed flag never leaks into a still-running job', () => {
    const stages = stageCountsToStages(shoppingAuditCounts(), null, {
      jobRunning: true,
      jobCompleted: false,
    });
    assert.equal(stages.verification?.status, 'running');
  });
});
