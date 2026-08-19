import type {
  ChildCompletionError,
  ChildCompletionPayload,
} from './childCompletion';

/**
 * Sliding-window child scheduler — pure state machine.
 *
 * Replaces wave barriers: instead of spawning N children and waiting for the
 * whole wave to finish, the window keeps N children in flight at all times and
 * spawns the next batch the moment one completes. The slowest child (e.g. a
 * TryKitt verification tail) no longer idles the other N−1 slots, and child
 * cold-starts stop happening in synchronized herds.
 *
 * The workflow drives this machine and owns every side effect (one shared
 * createHook, spawn steps, `for await` over completions); everything here is
 * deterministic bookkeeping, so it replays identically and is unit-testable.
 *
 * Failure semantics preserved from the wave design:
 * - `windowSize` CONSECUTIVE failures (zero successes between) = systemic
 *   failure (provider quota/outage) → stop scheduling, drain, abort. The wave
 *   equivalent was "entire wave failed".
 * - Any child reporting `inactive` (job paused/cancelled) → stop scheduling,
 *   drain, abort; the terminal state is classified from DB flags by the
 *   workflow's failure handler, exactly as before.
 * - Non-systemic failures don't stop the run: remaining batches still execute
 *   and the run ends paused-with-error (resumable) — never silent partial
 *   success.
 */

export type SchedulerAction =
  | { kind: 'spawn'; batchIndex: number }
  | { kind: 'awaitCompletion' }
  | { kind: 'done' };

export type SlidingWindowState = {
  readonly totalBatches: number;
  readonly windowSize: number;
  /** Next batch index that has never been spawned. */
  nextBatchIndex: number;
  /** Batch indices spawned and not yet completed, in spawn order. */
  inFlight: number[];
  /** Completion payloads with status 'ok', in completion order. */
  completedOk: ChildCompletionPayload[];
  failedBatches: number;
  /** Failures since the last 'ok' completion — systemic-outage detector. */
  consecutiveFailures: number;
  /** First 'failed' payload's error across the whole run. */
  firstFailure: ChildCompletionError | null;
  /** Once set, no further batches are spawned; in-flight children drain. */
  stopReason: 'systemic' | 'inactive' | 'halted' | null;
};

export function createWindowState(
  totalBatches: number,
  windowSize: number
): SlidingWindowState {
  return {
    totalBatches,
    windowSize: Math.max(1, windowSize),
    nextBatchIndex: 0,
    inFlight: [],
    completedOk: [],
    failedBatches: 0,
    consecutiveFailures: 0,
    firstFailure: null,
    stopReason: null,
  };
}

/** What the workflow loop should do next. Pure function of state. */
export function nextAction(state: SlidingWindowState): SchedulerAction {
  const canSpawn =
    state.stopReason === null &&
    state.nextBatchIndex < state.totalBatches &&
    state.inFlight.length < state.windowSize;
  if (canSpawn) {
    return { kind: 'spawn', batchIndex: state.nextBatchIndex };
  }
  if (state.inFlight.length > 0) {
    return { kind: 'awaitCompletion' };
  }
  return { kind: 'done' };
}

/** Record a successful spawn of the batch `nextAction` proposed. */
export function applySpawn(state: SlidingWindowState, batchIndex: number): void {
  if (batchIndex !== state.nextBatchIndex) {
    throw new Error(
      `applySpawn out of order: got batch ${batchIndex}, expected ${state.nextBatchIndex}`
    );
  }
  state.inFlight.push(batchIndex);
  state.nextBatchIndex += 1;
}

/**
 * Record a child completion payload. Returns false when the payload's
 * batchIndex is not in flight (a child bug — the caller should abort loudly
 * rather than loop forever on an unremovable resolved hook).
 */
export function applyCompletion(
  state: SlidingWindowState,
  payload: ChildCompletionPayload
): boolean {
  const at = state.inFlight.indexOf(payload.batchIndex);
  if (at === -1) return false;
  state.inFlight.splice(at, 1);

  if (payload.status === 'ok') {
    state.completedOk.push(payload);
    state.consecutiveFailures = 0;
    return true;
  }

  if (payload.status === 'inactive') {
    // Job paused/cancelled mid-batch: stop scheduling, let the rest drain.
    // 'systemic' takes precedence if already set — it carries the real cause.
    if (state.stopReason === null) state.stopReason = 'inactive';
    return true;
  }

  state.failedBatches += 1;
  state.consecutiveFailures += 1;
  if (state.firstFailure === null) {
    state.firstFailure = payload.error ?? {
      message: `Enrichment batch ${payload.batchIndex} failed`,
      code: null,
    };
  }
  if (
    state.consecutiveFailures >= state.windowSize &&
    state.stopReason === null
  ) {
    state.stopReason = 'systemic';
  }
  return true;
}

/**
 * Stop scheduling because the spawn step itself failed (job no longer active,
 * or start() error). In-flight children drain; the workflow rethrows the spawn
 * error after the drain so no child is orphaned mid-report.
 */
export function haltScheduling(state: SlidingWindowState): void {
  if (state.stopReason === null) state.stopReason = 'halted';
}
