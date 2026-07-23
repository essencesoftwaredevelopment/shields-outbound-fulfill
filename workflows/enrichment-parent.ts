/**
 * Vercel Workflow — parent orchestrator for enrichment jobs.
 *
 * Each batch is a TRUE child run: spawned with `start()` from a step and awaited
 * through a completion hook, so the parent event log stays O(children) instead of
 * O(children × steps). Direct-await composition flattened every child step into
 * this run's event log and hit the platform's 240s REPLAY_TIMEOUT at ~11k domains
 * (see server/docs/shopping-audit-replay-timeout-2026-07-21.md).
 */
import { createHook } from 'workflow';
import { start } from 'workflow/api';
import type { ParentWorkflowInput } from '@/lib/enrichment/types';
import {
  chunkDomains,
  resolveBatchSize,
  resolveWaveConcurrency,
} from '@/lib/enrichment/batchPlan';
import type {
  ChildCompletionError,
  ChildCompletionPayload,
} from '@/lib/enrichment/childCompletion';
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
    const completedBatches: ChildCompletionPayload[] = [];
    let failedBatches = 0;
    let firstFailure: ChildCompletionError | null = null;

    if (plan.batches.length) {
      for (
        let offset = 0;
        offset < plan.batches.length;
        offset += plan.waveConcurrency
      ) {
        await assertJobActiveStep(input);

        const wave = plan.batches.slice(offset, offset + plan.waveConcurrency);

        // One completion hook per child. Auto-generated (random) tokens: they are
        // handed to each child via its input, and unlike deterministic tokens they
        // can never collide with a lingering hook of a previous run for this job.
        // The SDK commits hook registrations at suspension BEFORE queueing steps,
        // so every hook below is durably registered before the spawn step runs —
        // a child can never report to an unregistered hook. Hooks are not
        // explicitly disposed: run-end cleanup releases them without spending an
        // extra hook_disposed event per child on this log.
        const waveHooks = wave.map(() => createHook<ChildCompletionPayload>());

        await spawnWaveChildrenStep(
          input,
          wave.map(
            (batchDomains, waveIndex): ChildRunInput => ({
              jobId: input.jobId,
              agencyId: input.agencyId,
              batchDomains,
              batchIndex: offset + waveIndex,
              pipelineMode: plan.pipelineMode,
              completionToken: waveHooks[waveIndex].token,
            })
          )
        );

        // Children never reject their hook — failures arrive as payload statuses
        // (allSettled semantics live in the payload, per B2), so Promise.all is
        // safe and one bad batch cannot cancel its in-flight siblings.
        const waveResults = await Promise.all(waveHooks);

        let waveFailed = 0;
        let waveInactive = 0;
        for (const result of waveResults) {
          if (result.status === 'ok') {
            completedBatches.push(result);
          } else if (result.status === 'inactive') {
            waveInactive += 1;
          } else {
            waveFailed += 1;
            failedBatches += 1;
            if (firstFailure === null) {
              firstFailure = result.error ?? {
                message: `Enrichment batch ${result.batchIndex} failed`,
                code: null,
              };
            }
          }
        }

        // Systemic failure (whole wave down — e.g. provider quota/outage): stop now
        // instead of burning the remaining waves. Surface the first reason so the
        // catch classifies it (pause/cancel/error) from the authoritative DB flags.
        if (wave.length > 0 && waveFailed === wave.length) {
          throw toWorkflowError(firstFailure);
        }

        // A child saw the job paused/cancelled mid-batch: stop scheduling further
        // waves. handleWorkflowFailureStep classifies the terminal state from the
        // DB flags — the parent never interprets child errors itself.
        if (waveInactive > 0) {
          throw toWorkflowError(
            firstFailure ?? {
              message:
                'Job is no longer active — stopped scheduling enrichment batches.',
              code: null,
            }
          );
        }

        // Progress reconcile is best-effort: a stale UI must never fail the job.
        try {
          await reconcileStagesStep(input);
        } catch {
          /* ignore — finalize runs an authoritative reconcile anyway */
        }
      }
    }

    // Never report success while a batch failed: pause-with-error (resumable) so a resume
    // reprocesses only the still-pending domains via the idempotent DB queues. A clean run
    // (no failures) falls through to finalize.
    if (failedBatches > 0) {
      // Surface the real reason (e.g. credit exhaustion) so it reaches jobs.error;
      // fall back to a generic message only if no reason was captured.
      if (firstFailure) throw toWorkflowError(firstFailure);
      throw new Error(
        `${failedBatches} enrichment batch(es) failed — resume the job to retry the affected domains.`
      );
    }

    return finalizeStep(input, completedBatches);
  } catch (err) {
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

  const allDomains = await enrichment.listPendingDomainNames(input.jobId);
  const batchSize = resolveBatchSize(ctx.pipelineMode, ctx.options);
  const waveConcurrency = resolveWaveConcurrency(ctx.options);

  return {
    pipelineMode: ctx.pipelineMode,
    batchSize,
    waveConcurrency,
    batches: chunkDomains(allDomains, batchSize),
  };
}

/**
 * Spawn every batch of the wave as an independent child run (`wrun_`). One step
 * per wave keeps spawning chunked (wave size caps the `start()` calls per step)
 * and the child run ids land in this step's result for the Workflow UI.
 */
async function spawnWaveChildrenStep(
  input: ParentWorkflowInput,
  children: ChildRunInput[]
) {
  'use step';

  const childRunIds: string[] = [];
  for (const child of children) {
    const run = await start(enrichmentChildRun, [child]);
    childRunIds.push(run.runId);
  }
  console.log(
    `[enrichment-parent] job ${input.jobId} spawned ${childRunIds.length} child run(s) ` +
      `(batches ${children[0]?.batchIndex}–${children[children.length - 1]?.batchIndex}): ` +
      childRunIds.join(', ')
  );
  return childRunIds;
}

async function assertJobActiveStep(input: ParentWorkflowInput) {
  'use step';

  const enrichment = await loadEnrichment();
  await enrichment.assertJobActive(input.jobId, input.agencyId);
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
assertJobActiveStep.maxRetries = 0;
// Idempotent reads/work — safe to retry through a transient DB/provider blip.
domainPrepStep.maxRetries = 1;
prepareBatchPlanStep.maxRetries = 2;
// A retry after a partial spawn would start duplicate child runs for the same
// batches (start() has no idempotency key on workflow@4.5), double-charging
// Serper/OpenAI until Phase 2 lands per-domain idempotency. A failed spawn
// surfaces as paused-with-error, resumable like any batch failure.
spawnWaveChildrenStep.maxRetries = 0;
reconcileStagesStep.maxRetries = 0; // best-effort (wrapped in try/catch above)
finalizeStep.maxRetries = 2;
// Recording the failure state must itself be resilient — this is the last line of
// defense against a silent zombie job, so retry it harder than the work steps.
handleWorkflowFailureStep.maxRetries = 3;
