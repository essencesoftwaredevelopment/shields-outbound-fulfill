import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstantlyCardModel, buildStageCardModel } from '../stageCardModel.ts';
import { autoInstantlyFromOptions } from '../realtimeRow.ts';
import { stageCountsToStages, type JobStageCounts } from '../../enrichment/stageCounts.ts';

/** Job 1790204345024-0vdyss as get_job_stage_counts returned it once complete. */
function completedJobCounts(): JobStageCounts {
  return {
    jobId: '1790204345024-0vdyss',
    pipelineMode: 'standard',
    domainPrep: {
      total: 845, pending: 0, processing: 0, done: 844, skipped: 1, processable: 844,
      dns: { checked: 845, live: 843, dead: 1, unknown: 1, skipped: 0 },
    },
    founders: { processed: 844, found: 371 },
    emailDiscovery: { processed: 371, found: 54, notFound: 317, errors: 0 },
    verification: { verified: 54, valid: 46, invalid: 8, unknown: 0, validRisky: 0 },
    personalization: { processed: 41, personalized: 41 },
    costs: { founders: 0.84, emailDiscovery: 0.27, verification: 0.08, personalization: 0.066235 },
    contacts: { total: 844 },
  };
}

describe('buildStageCardModel', () => {
  const stages = stageCountsToStages(completedJobCounts(), null, {
    jobCompleted: true,
    job: { personalizeFirstLine: true },
  });

  it('describes every standard stage with a hero, a detail line and its cost', () => {
    const domain = buildStageCardModel('domainPrep', stages.domainPrep);
    assert.equal(domain.hero, 844);
    assert.equal(domain.detail, '845 checked · 843 live · 1 dead · 1 unresolved');
    assert.equal(domain.cost, null);

    const founders = buildStageCardModel('founders', stages.founders);
    assert.equal(founders.hero, 371);
    assert.equal(founders.detail, '844 searched · 44% yield');
    assert.equal(founders.cost, 0.84);

    const emails = buildStageCardModel('emailDiscovery', stages.emailDiscovery);
    assert.equal(emails.hero, 54);
    assert.equal(emails.detail, '371 searched · 14.6% hit rate');

    const verification = buildStageCardModel('verification', stages.verification);
    assert.equal(verification.hero, 46);
    assert.equal(verification.detail, '54 checked · 8 invalid');

    const personalization = buildStageCardModel('personalization', stages.personalization, { personalizeFirstLine: true });
    assert.equal(personalization.hero, 41);
    assert.equal(personalization.detail, '41 of 46 personalized');
    assert.equal(personalization.cost, 0.066235);

    for (const model of [domain, founders, emails, verification, personalization]) {
      assert.equal(model.tone, 'completed');
      assert.ok(!/awaiting/i.test(model.detail), model.detail);
    }
  });

  it('shows a started costed stage with no recorded cost as $0, not blank', () => {
    const counts = completedJobCounts();
    counts.costs = {};
    const s = stageCountsToStages(counts, null, { jobCompleted: true });
    assert.equal(buildStageCardModel('verification', s.verification).cost, 0);
  });

  it('names the stage it is waiting on instead of "Awaiting..."', () => {
    const pending = buildStageCardModel(
      'verification',
      { status: 'pending', startedAt: null, completedAt: null, error: null, summary: null, progress: null },
      { upstreamTitle: 'Email Discovery' },
    );
    assert.equal(pending.hero, null);
    assert.equal(pending.detail, 'Waiting for Email Discovery');
    assert.equal(pending.cost, null);
  });

  it('marks stages that were not run as skipped', () => {
    const model = buildStageCardModel(
      'personalization',
      { status: 'completed', startedAt: null, completedAt: null, error: null, summary: { skipped: true }, progress: null },
      { personalizeFirstLine: false },
    );
    assert.equal(model.tone, 'skipped');
    assert.equal(model.detail, 'Not enabled for this job');
  });

  it('turns a TryKitt credit-exhaustion error into an actionable line', () => {
    const model = buildStageCardModel('emailDiscovery', {
      status: 'error', startedAt: null, completedAt: null, error: 'TryKitt: out of credits', summary: null, progress: null,
    });
    assert.equal(model.tone, 'error');
    assert.equal(model.creditExhausted, true);
    assert.match(model.detail, /add credits/i);
  });
});

describe('buildInstantlyCardModel', () => {
  const auto = (added: number, failed = 0, lastError: string | null = null) =>
    ({ campaignName: 'Email Conversion System', added, failed, lastError });

  it('waits for personalization before any add', () => {
    const m = buildInstantlyCardModel(auto(0), { status: 'running', paused: false }, { upstreamTitle: 'Personalization' });
    assert.equal(m.tone, 'pending');
    assert.equal(m.hero, null);
    assert.match(m.detail, /Waiting for Personalization/);
  });

  it('counts adds while the job runs, including failures', () => {
    const m = buildInstantlyCardModel(auto(2349, 94, 'Lead limit reached'), { status: 'running', paused: false });
    assert.equal(m.tone, 'running');
    assert.equal(m.hero, 2349);
    assert.match(m.detail, /Email Conversion System.*94 failed/);
  });

  it('completes clean, or flags adds that still failed after the end-of-job retry', () => {
    const ok = buildInstantlyCardModel(auto(4487), { status: 'completed', paused: false });
    assert.equal(ok.tone, 'completed');
    assert.equal(ok.hero, 4487);
    const bad = buildInstantlyCardModel(auto(2349, 2139, 'Lead limit reached. Remaining uploads: 52.'), { status: 'completed', paused: false });
    assert.equal(bad.tone, 'error');
    assert.equal(bad.chip, 'Needs retry');
    assert.match(bad.detail, /2,139 failed — Lead limit reached/);
  });

  it('parses the job options (realtime row and API share this)', () => {
    assert.equal(autoInstantlyFromOptions({}), null);
    assert.equal(autoInstantlyFromOptions({ autoInstantly: {} }), null);
    assert.deepEqual(
      autoInstantlyFromOptions({
        autoInstantly: { campaignId: 'c1', campaignName: 'Email Conversion System' },
        autoInstantlyStats: { added: 46, failed: 0, lastError: null },
      }),
      { campaignName: 'Email Conversion System', added: 46, failed: 0, lastError: null },
    );
  });
});
