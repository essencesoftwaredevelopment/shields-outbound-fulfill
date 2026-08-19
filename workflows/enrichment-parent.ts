/**
 * Vercel Workflow — parent orchestrator for enrichment jobs.
 *
 * Each batch is a TRUE child run: spawned with `start()` from a step and awaited
 * through a completion hook, so the parent event log stays O(children) instead of
 * O(children × steps). Direct-await composition flattened every child step into
 * this run's event log and hit the platform's 240s REPLAY_TIMEOUT at ~11k domains
 * (see server/docs/shopping-audit-replay-timeout-2026-07-21.md).
 *
 * Scheduling is a SLIDING WINDOW, not waves: `waveConcurrency` children stay in
 * flight at all times, and the next batch spawns the moment one completes. The
 * previous wave barrier made the whole job wait on each wave's slowest child
 * (e.g. a TryKitt verification tail) and cold-started every wave's children
 * simultaneously — the synchronized herd behind the wave-boundary pg-pool
 * connect-timeout bursts (see
 * server/docs/wave-boundary-connection-storms-2026-07-26.md). Spawning one
 * child per step also serializes cold-starts naturally.
 *
 * Completion uses ONE shared hook per parent run, consumed with `for await`
 * (workflow's multi-payload pattern). Every child calls `resumeHook` on the
 * same token, so every completion wakes the parent and the sliding window
 * stays full. Per-child `createHook` + `Promise.race` did not: after a refill
 * spawn, later `hook_received` events for older in-flight children were
 * recorded on the parent run but never resumed it (job 1787155726011-2lozbz,
 * effective concurrency 1).
 */
import { createHook } from 'workflow';
import { start } from 'workflow/api';
import type { ParentWorkflowInput } from '@/lib/enrichment/types';
import {
  buildBatchLists,
  resolveBatchSize,
  resolveWaveConcurrency,
} from '@/lib/enrichment/batchPlan';
import type {
  ChildCompletionError,
  ChildCompletionPayload,
} from '@/lib/enrichment/childCompletion';
import {
  applyCompletion,
  applySpawn,
  createWindowState,
  haltScheduling,
  nextAction,
} from '@/lib/enrichment/slidingWindow';
import { isStartRejection } from '@/lib/enrichment/startRejection';
import { enrichmentChildRun, type ChildRunInput } from './enrichment-child';

type EnrichmentModule = typeof import('../server/src/enrichment/index.js');

async function loadEnrichment(): Promise<EnrichmentModule> {
  return import('../server/src/enrichment/index.js');
}

export async function enrichmentParentWorkflow(input: ParentWorkflowInput) {
  'use workflow';

  try {
    await hydrateAndStartStep(input);
    await domainPrepStep(input);

    const plan = await prepareBatchPlanStep(input);
    const state = createWindowState(plan.batches.length, plan.waveConcurrency);

    if (plan.batches.length) {
      // One shared completion hook for every child of this parent run.
      // Random token: cannot collide with a lingering hook from a previous
      // parent run for this job. Registration commits at the first
      // spawnChildStep suspension, before that step is queued, so a child
      // can never report to an unregistered hook. `using` disposes the hook
      // when this block exits (after in-flight children have drained).
      using completionHook = createHook<ChildCompletionPayload>();
      // On a spawn-step failure (job paused, start() error) we stop scheduling
      // but DRAIN in-flight children before rethrowing, so no child ends up
      // reporting to a released hook of an already-ended parent run.
      let spawnFailure: unknown = null;
      let completionsSinceReconcile = 0;

      const childInput = (batchIndex: number): ChildRunInput => {
        const batch = plan.batches[batchIndex];
        return {
          jobId: input.jobId,
          agencyId: input.agencyId,
          batchDomains: batch.domains,
          batchIndex,
          pipelineMode: plan.pipelineMode,
          resumeStagesOnly: batch.resumeStagesOnly,
          completionToken: completionHook.token,
        };
      };

      // Fill the window before waiting — `for await` on an empty hook hangs.
      // spawnChildStep is awaited here (not in a nested async helper) so the
      // workflow compiler still sees it as a step.
      for (;;) {
        const action = nextAction(state);
        if (action.kind !== 'spawn') break;
        try {
          await spawnChildStep(input, childInput(action.batchIndex));
        } catch (err) {
          spawnFailure = err;
          haltScheduling(state);
          break;
        }
        applySpawn(state, action.batchIndex);
      }

      // Children never reject the hook (failures arrive as payload statuses,
      // per B2), so one bad batch cannot cancel its in-flight siblings.
      if (state.inFlight.length > 0) {
        for await (const payload of completionHook) {
          if (!applyCompletion(state, payload)) {
            // A payload for a batch we don't have in flight can only be a
            // child echoing the wrong index — abort instead of looping on
            // completions that never shrink inFlight.
            throw new Error(
              `Child completion reported unknown batch index ${payload.batchIndex}`
            );
          }

          // Progress reconcile is best-effort: a stale UI must never fail the
          // job. Same average cadence as the old once-per-wave reconcile.
          completionsSinceReconcile += 1;
          if (completionsSinceReconcile >= state.windowSize) {
            completionsSinceReconcile = 0;
            try {
              await reconcileStagesStep(input);
            } catch {
              /* ignore — finalize runs an authoritative reconcile anyway */
            }
          }

          for (;;) {
            const action = nextAction(state);
            if (action.kind !== 'spawn') break;
            try {
              await spawnChildStep(input, childInput(action.batchIndex));
            } catch (err) {
              spawnFailure = err;
              haltScheduling(state);
              break;
            }
            applySpawn(state, action.batchIndex);
          }

          if (nextAction(state).kind === 'done') break;
        }
      }

      // In-flight children have drained — safe to surface terminal causes now.
      if (spawnFailure !== null) {
        throw spawnFailure;
      }
      // Systemic failure (windowSize consecutive failures, zero successes
      // between — e.g. provider quota/outage): don't burn the remaining
      // batches. Surface the first reason so the catch classifies it
      // (pause/cancel/error) from the authoritative DB flags.
      //
      // 'inactive': a child saw the job paused/cancelled mid-batch — the
      // parent never interprets child errors itself; handleWorkflowFailureStep
      // classifies the terminal state from the DB flags.
      if (state.stopReason === 'systemic' || state.stopReason === 'inactive') {
        throw toWorkflowError(
          state.firstFailure ?? {
            message:
              'Job is no longer active — stopped scheduling enrichment batches.',
            code: null,
          }
        );
      }
    }

    // Never report success while a batch failed: pause-with-error (resumable) so a resume
    // reprocesses only the still-pending domains via the idempotent DB queues. A clean run
    // (no failures) falls through to finalize.
    if (state.failedBatches > 0) {
      // Surface the real reason (e.g. credit exhaustion) so it reaches jobs.error;
      // fall back to a generic message only if no reason was captured.
      if (state.firstFailure) throw toWorkflowError(state.firstFailure);
      throw new Error(
        `${state.failedBatches} enrichment batch(es) failed — resume the job to retry the affected domains.`
      );
    }

    return finalizeStep(input, state.completedOk);
  } catch (err) {
    // A guardWorkflowStart rejection means THIS run is a duplicate (double
    // trigger / auto-resume race). End it without touching job state: routing it
    // through the failure handler would pause the healthy run's job.
    if (isStartRejection(toErrorInfo(err))) {
      return { stopped: 'duplicate' as const };
    }
    // Keystone failure handler: an uncaught throw here would otherwise leave the job
    // stuck at status='running' forever. Record a recoverable terminal state instead.
    const { disposition } = await handleWorkflowFailureStep(input, toErrorInfo(err));
    if (disposition === 'error') {
      // Re-throw so the Vercel run is marked failed (alerting/observability); the job
      // row is already paused-with-error and resumable via the existing resume route.
      throw err;
    }
    // Paused / cancelled are expected control flow, not failures — end the run cleanly.
    return { stopped: disposition };
  }
}

/** Reduce an arbitrary thrown value to a serializable shape for the failure step. */
function toErrorInfo(err: unknown): { message: string; code: string | null } {
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown };
    return {
      message: typeof e.message === 'string' ? e.message : String(err),
      code: typeof e.code === 'string' ? e.code : null,
    };
  }
  return { message: String(err), code: null };
}

/** Rebuild an Error (with code) from a child completion payload's error info. */
function toWorkflowError(info: ChildCompletionError | null): Error {
  const err = new Error(info?.message ?? 'Enrichment batch failed') as Error & {
    code?: string;
  };
  if (info?.code) err.code = info.code;
  return err;
}

async function hydrateAndStartStep(input: ParentWorkflowInput) {
  'use step';

  const enrichment = await loadEnrichment();
  await enrichment.guardWorkflowStart(input.jobId, input.agencyId);
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);

  await enrichment.markJobRunning(
    input.jobId,
    input.agencyId,
    input.workflowRunId ?? null
  );

  return { pipelineMode: ctx.pipelineMode };
}

async function domainPrepStep(input: ParentWorkflowInput) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runDomainPrep(ctx);
}

async function prepareBatchPlanStep(input: ParentWorkflowInput) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);

  // Two lists (C1): pending domains run the full pipeline; domains past
  // 'pending' whose contacts still hold queue work (the incident's verified-146
  // -of-2,774 gap) run queue stages only. Same queue predicates as
  // jobHasRemainingPipelineWork, so resume schedules exactly what would
  // otherwise block finalize.
  const pendingDomains = await enrichment.listPendingDomainNames(input.jobId);
  const resumeStageDomains = await enrichment.listResumeStageDomainNames(ctx);
  const batchSize = resolveBatchSize(ctx.pipelineMode, ctx.options);
  const waveConcurrency = resolveWaveConcurrency(ctx.options);

  return {
    pipelineMode: ctx.pipelineMode,
    batchSize,
    waveConcurrency,
    batches: buildBatchLists(pendingDomains, resumeStageDomains, batchSize),
  };
}

/**
 * Spawn ONE batch as an independent child run (`wrun_`). One child per step
 * serializes cold-starts (no synchronized herd) and removes the old
 * partial-wave ambiguity: with a single `start()` per step, a failed spawn
 * step can never leave an unknown number of siblings running.
 *
 * The activity assert lives inside the step (one indexed SELECT next to the
 * far heavier `start()`): a paused/cancelled job fails the next spawn attempt,
 * and the workflow drains in-flight children before classifying the stop.
 */
async function spawnChildStep(
  input: ParentWorkflowInput,
  child: ChildRunInput
) {
  'use step';

  const enrichment = await loadEnrichment();
  await enrichment.assertJobActive(input.jobId, input.agencyId);

  const run = await start(enrichmentChildRun, [child]);
  console.log(
    `[enrichment-parent] job ${input.jobId} spawned child run ${run.runId} ` +
      `(batch ${child.batchIndex} of ${child.batchDomains.length} domains)`
  );
  return run.runId;
}

async function reconcileStagesStep(input: ParentWorkflowInput) {
  'use step';

  const enrichment = await loadEnrichment();
  await enrichment.runStageReconcile(input.jobId, input.agencyId);
}

async function finalizeStep(
  input: ParentWorkflowInput,
  batchResults: unknown[]
) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  const result = await enrichment.runFinalize(ctx);
  return { ...result, batches: batchResults.length };
}

async function handleWorkflowFailureStep(
  input: ParentWorkflowInput,
  errorInfo: { message: string; code: string | null }
) {
  'use step';

  const enrichment = await loadEnrichment();
  return enrichment.handleWorkflowFailure(
    input.jobId,
    input.agencyId,
    errorInfo
  );
}

// guardWorkflowStart + assertJobActive throw INTENTIONALLY (already-running / paused /
// cancelled) — retrying those just delays propagation, so keep them at 0.
hydrateAndStartStep.maxRetries = 0;
// Idempotent reads/work — safe to retry through a transient DB/provider blip.
domainPrepStep.maxRetries = 1;
prepareBatchPlanStep.maxRetries = 2;
// A retry could double-spawn the batch (start() has no idempotency key on
// workflow@4.5), double-charging Serper/OpenAI until Phase 2 lands per-domain
// idempotency — and the embedded assertJobActive throws intentionally. A
// failed spawn drains in-flight children, then surfaces as paused-with-error,
// resumable like any batch failure.
spawnChildStep.maxRetries = 0;
reconcileStagesStep.maxRetries = 0; // best-effort (wrapped in try/catch above)
finalizeStep.maxRetries = 2;
// Recording the failure state must itself be resilient — this is the last line of
// defense against a silent zombie job, so retry it harder than the work steps.
handleWorkflowFailureStep.maxRetries = 3;
