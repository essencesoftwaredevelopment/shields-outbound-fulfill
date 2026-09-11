import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    WARM_FOLLOW_UP_PREVIEW_STEPS,
    WARM_FOLLOW_UP_STEPS,
    isWarmFollowUpStepId,
    resolveWarmFollowUpProgress
} from '../steps.js';

test('preview stepper hides the send dot', () => {
    assert.deepEqual(
        WARM_FOLLOW_UP_PREVIEW_STEPS.map((step) => step.id),
        ['hydrate', 'brief', 'generate']
    );
    assert.equal(WARM_FOLLOW_UP_STEPS.at(-1).id, 'send');
    assert.equal(isWarmFollowUpStepId('generate'), true);
    assert.equal(isWarmFollowUpStepId('popup'), false);
});

test('resolveWarmFollowUpProgress highlights hydrate while queued', () => {
    const queued = resolveWarmFollowUpProgress('running', null, 'preview');
    assert.equal(queued.complete, false);
    assert.equal(queued.currentId, 'hydrate');
});

test('resolveWarmFollowUpProgress tracks the stamped write step', () => {
    const writing = resolveWarmFollowUpProgress('running', 'generate', 'preview');
    assert.equal(writing.currentId, 'generate');
    assert.equal(writing.complete, false);
});

test('completed preview is marked complete', () => {
    const done = resolveWarmFollowUpProgress('completed', 'generate', 'preview');
    assert.equal(done.complete, true);
});
