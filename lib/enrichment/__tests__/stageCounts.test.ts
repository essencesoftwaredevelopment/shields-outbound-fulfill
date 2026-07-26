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

/** RPC payload shape of the 5,923-domain CSV-import job (1785076206274-7530hn)
 *  mid-run: skipFounderFinder + skipEmailFinder, emails from the upload,
 *  wave 1 done (1,200 domains verified), 4,723 still pending. */
function skipFlagsCounts(): JobStageCounts {
  return {
    jobId: 'test-skip-job',
    pipelineMode: 'standard',
    domainCheckSkipped: true,
    domainPrep: {
      total: 5923,
      pending: 4723,
      processing: 0,
      done: 1200,
      skipped: 0,
      processable: 5923,
      dns: { checked: 0, live: 0, dead: 0, unknown: 0, skipped: 0 },
    },
    founders: { processed: 1200, found: 1200 },
    // Email discovery is skipped: `found` only counts contacts from processed
    // domains, so it tracks `verified` in lockstep — the incident's bad denominator.
    emailDiscovery: { processed: 0, found: 1200 },
    verification: { verified: 1200, valid: 628, invalid: 4, unknown: 14, validRisky: 554 },
    personalization: { processed: 1063, personalized: 1063 },
    contacts: { total: 1200 },
  };
}

const SKIP_JOB = {
  skipFounderFinder: true,
  skipEmailFinder: true,
  skipVerification: false,
  personalizeFirstLine: true,
};

describe('stageCountsToStages (skip-flag jobs)', () => {
  it('marks skipped stages completed so the status line never announces "Preparing Email Discovery…"', () => {
    const stages = stageCountsToStages(skipFlagsCounts(), null, { jobRunning: true, job: SKIP_JOB });
    assert.equal(stages.emailDiscovery?.status, 'completed');
    assert.equal((stages.emailDiscovery?.summary as Record<string, unknown>)?.skipped, true);
    assert.equal(stages.founders?.status, 'completed');
    assert.equal((stages.founders?.summary as Record<string, unknown>)?.skipped, true);
  });

  it('verification uses the cohort denominator on skipEmailFinder jobs — never lockstep emailFound', () => {
    const stages = stageCountsToStages(skipFlagsCounts(), null, { jobRunning: true, job: SKIP_JOB });
    // 1,200/1,200 vs emailFound read "Completed" from the first wave; the real
    // shape is 1,200 of 5,923.
    assert.equal(stages.verification?.status, 'running');
    assert.equal(stages.verification?.progress?.total, 5923);
    assert.equal(stages.verification?.progress?.processed, 1200);
  });

  it('personalization is not marked skipped when personalizeFirstLine is on', () => {
    const stages = stageCountsToStages(skipFlagsCounts(), null, { jobRunning: true, job: SKIP_JOB });
    assert.notEqual(stages.personalization?.status, 'pending');
    assert.equal((stages.personalization?.summary as Record<string, unknown>)?.skipped, undefined);
  });

  it('without job options the legacy shape is unchanged', () => {
    const stages = stageCountsToStages(skipFlagsCounts(), null, { jobRunning: true });
    // Legacy fallback keeps emailFound as the verification denominator.
    assert.equal(stages.verification?.progress?.total, 1200);
    assert.equal(stages.emailDiscovery?.status, 'pending');
  });
});
