import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    INTERESTED_RESEARCH_STEPS,
    isInterestedResearchStepId,
    resolveResearchProgress
} from '../steps.js';

test('step catalog is a stable 7-step horizontal sequence', () => {
    assert.deepEqual(
        INTERESTED_RESEARCH_STEPS.map((step) => step.id),
        ['hydrate', 'research', 'synthesize', 'persist', 'size', 'popup', 'finalize']
    );
    assert.equal(isInterestedResearchStepId('synthesize'), true);
    assert.equal(isInterestedResearchStepId('size'), true);
    assert.equal(isInterestedResearchStepId('serper'), false);
});

test('resolveResearchProgress highlights the first dot while queued', () => {
    const queued = resolveResearchProgress('researching', null);
    assert.equal(queued.complete, false);
    assert.equal(queued.currentIndex, 0);
    assert.equal(queued.currentId, 'hydrate');
});

test('resolveResearchProgress tracks the stamped Vercel step', () => {
    const brief = resolveResearchProgress('researching', 'synthesize');
    assert.equal(brief.currentIndex, 2);
    assert.equal(brief.currentId, 'synthesize');
    assert.equal(brief.complete, false);
});

test('resolveResearchProgress treats pending_review as finished', () => {
    const done = resolveResearchProgress('pending_review', 'finalize');
    assert.equal(done.complete, true);
    assert.equal(done.currentIndex, INTERESTED_RESEARCH_STEPS.length - 1);
});
