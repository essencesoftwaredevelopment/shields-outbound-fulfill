import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildCompletionPayload } from '../childCompletion.ts';
import {
  applyCompletion,
  applySpawn,
  createWindowState,
  haltScheduling,
  nextAction,
  type SlidingWindowState,
} from '../slidingWindow.ts';

function ok(batchIndex: number): ChildCompletionPayload {
  return { batchIndex, status: 'ok', summary: { domainCount: 1, auditSignals: 0 } };
}

function failed(batchIndex: number, message = `boom ${batchIndex}`): ChildCompletionPayload {
  return { batchIndex, status: 'failed', error: { message, code: null } };
}

function inactive(batchIndex: number): ChildCompletionPayload {
  return { batchIndex, status: 'inactive', error: { message: 'Job paused', code: null } };
}

/** Drive spawns until the machine stops proposing them; return spawned indices. */
function spawnAllProposed(state: SlidingWindowState): number[] {
  const spawned: number[] = [];
  for (;;) {
    const action = nextAction(state);
    if (action.kind !== 'spawn') return spawned;
    applySpawn(state, action.batchIndex);
    spawned.push(action.batchIndex);
  }
}

describe('createWindowState', () => {
  it('clamps window size to at least 1', () => {
    assert.equal(createWindowState(10, 0).windowSize, 1);
  });
});

describe('window filling and sliding', () => {
  it('fills the window to windowSize, then awaits', () => {
    const state = createWindowState(10, 6);
    assert.deepEqual(spawnAllProposed(state), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(nextAction(state), { kind: 'awaitCompletion' });
  });

  it('spawns the next batch immediately after one completion — window stays full', () => {
    const state = createWindowState(10, 6);
    spawnAllProposed(state);
    // Out-of-order completion (batch 3 first) must still free a slot.
    applyCompletion(state, ok(3));
    assert.deepEqual(nextAction(state), { kind: 'spawn', batchIndex: 6 });
    applySpawn(state, 6);
    assert.deepEqual(nextAction(state), { kind: 'awaitCompletion' });
    assert.deepEqual(state.inFlight, [0, 1, 2, 4, 5, 6]);
  });

  it('drains after the batch list is exhausted, then reports done', () => {
    const state = createWindowState(2, 6);
    assert.deepEqual(spawnAllProposed(state), [0, 1]);
    applyCompletion(state, ok(0));
    assert.deepEqual(nextAction(state), { kind: 'awaitCompletion' });
    applyCompletion(state, ok(1));
    assert.deepEqual(nextAction(state), { kind: 'done' });
    assert.equal(state.completedOk.length, 2);
    assert.equal(state.failedBatches, 0);
    assert.equal(state.stopReason, null);
  });

  it('reports done immediately for an empty plan', () => {
    assert.deepEqual(nextAction(createWindowState(0, 6)), { kind: 'done' });
  });

  it('rejects out-of-order spawns', () => {
    const state = createWindowState(10, 6);
    assert.throws(() => applySpawn(state, 3), /out of order/);
  });
});

describe('failure semantics', () => {
  it('windowSize consecutive failures = systemic stop; drain, keep firstFailure', () => {
    const state = createWindowState(20, 3);
    spawnAllProposed(state);
    applyCompletion(state, failed(0, 'quota exhausted'));
    applyCompletion(state, failed(1));
    assert.equal(state.stopReason, null);
    applyCompletion(state, failed(2));
    assert.equal(state.stopReason, 'systemic');
    assert.equal(state.firstFailure?.message, 'quota exhausted');
    // No further spawns; nothing in flight → done.
    assert.deepEqual(nextAction(state), { kind: 'done' });
  });

  it('a success between failures resets the systemic detector', () => {
    const state = createWindowState(20, 3);
    spawnAllProposed(state);
    applyCompletion(state, failed(0));
    applyCompletion(state, failed(1));
    applyCompletion(state, ok(2));
    // Window refills before the next failures land.
    spawnAllProposed(state);
    applyCompletion(state, failed(3));
    applyCompletion(state, failed(4));
    assert.equal(state.stopReason, null);
    assert.equal(state.failedBatches, 4);
    assert.equal(state.consecutiveFailures, 2);
  });

  it('isolated failures never stop scheduling — run ends with failedBatches set', () => {
    const state = createWindowState(4, 2);
    spawnAllProposed(state);
    applyCompletion(state, failed(0));
    spawnAllProposed(state);
    applyCompletion(state, ok(1));
    spawnAllProposed(state);
    applyCompletion(state, ok(2));
    applyCompletion(state, failed(3));
    assert.deepEqual(nextAction(state), { kind: 'done' });
    assert.equal(state.failedBatches, 2);
    assert.equal(state.stopReason, null);
    assert.equal(state.completedOk.length, 2);
  });

  it('inactive stops scheduling and drains in-flight siblings', () => {
    const state = createWindowState(20, 3);
    spawnAllProposed(state);
    applyCompletion(state, inactive(1));
    assert.equal(state.stopReason, 'inactive');
    // Two siblings still in flight — drain them, no new spawns.
    assert.deepEqual(nextAction(state), { kind: 'awaitCompletion' });
    applyCompletion(state, ok(0));
    assert.deepEqual(nextAction(state), { kind: 'awaitCompletion' });
    applyCompletion(state, ok(2));
    assert.deepEqual(nextAction(state), { kind: 'done' });
  });

  it('systemic takes precedence over a later inactive', () => {
    const state = createWindowState(20, 2);
    spawnAllProposed(state);
    applyCompletion(state, failed(0, 'credit exhausted'));
    applyCompletion(state, failed(1, 'credit exhausted'));
    assert.equal(state.stopReason, 'systemic');
    // A drain-phase inactive must not mask the systemic cause.
    haltScheduling(state);
    assert.equal(state.stopReason, 'systemic');
  });

  it('haltScheduling stops spawns but lets the drain finish', () => {
    const state = createWindowState(20, 3);
    spawnAllProposed(state);
    haltScheduling(state);
    assert.equal(state.stopReason, 'halted');
    assert.deepEqual(nextAction(state), { kind: 'awaitCompletion' });
    applyCompletion(state, ok(0));
    applyCompletion(state, ok(1));
    applyCompletion(state, ok(2));
    assert.deepEqual(nextAction(state), { kind: 'done' });
  });

  it('rejects completions for batches not in flight', () => {
    const state = createWindowState(10, 2);
    spawnAllProposed(state);
    assert.equal(applyCompletion(state, ok(7)), false);
    assert.equal(applyCompletion(state, ok(0)), true);
    assert.equal(applyCompletion(state, ok(0)), false);
  });
});

describe('single-slot window (waveConcurrency 1)', () => {
  it('behaves like strict sequential batches; one failure is systemic', () => {
    const state = createWindowState(3, 1);
    assert.deepEqual(spawnAllProposed(state), [0]);
    applyCompletion(state, ok(0));
    assert.deepEqual(spawnAllProposed(state), [1]);
    applyCompletion(state, failed(1));
    assert.equal(state.stopReason, 'systemic');
    assert.deepEqual(nextAction(state), { kind: 'done' });
  });
});
