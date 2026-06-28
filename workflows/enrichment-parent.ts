/**
 * Vercel Workflow — parent orchestrator for enrichment jobs.
 *
 * Child batches are awaited at the workflow level (not inside one long step) so
 * 10k+ domain jobs stay within per-invocation maxDuration limits.
 */
import {
  CHILD_WAVE_CONCURRENCY,
  type ParentWorkflowInput,
} from '@/lib/enrichment/types';
import { chunkDomains, resolveBatchSize } from '@/lib/enrichment/batchPlan';
import { enrichmentChildWorkflow } from './enrichment-child';

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
    const batchResults: unknown[] = [];
    let failedBatches = 0;
    let firstFailure: unknown = null;

    if (plan.batches.length) {
      for (let offset = 0; offset < plan.batches.length; offset += CHILD_WAVE_CONCURRENCY) {
        await assertJobActiveStep(input);

        const wave = plan.batches.slice(offset, offset + CHILD_WAVE_CONCURRENCY);
        // allSettled, not all: one bad batch must not cancel its in-flight siblings.
        const settled = await Promise.allSettled(
          wave.map((batchDomains, waveIndex) =>
            enrichmentChildWorkflow({
              jobId: input.jobId,
              agencyId: input.agencyId,
              batchDomains,
              batchIndex: offset + waveIndex,
              pipelineMode: plan.pipelineMode,
            })
          )
        );

        for (const r of settled) {
          if (r.status === 'fulfilled') batchResults.push(r.value);
          else {
            failedBatches += 1;
            if (firstFailure === null) firstFailure = r.reason;
          }
        }

        // Systemic failure (whole wave down — e.g. provider quota/outage): stop now
        // instead of burning the remaining waves. Surface the first reason so the catch
        // classifies it (pause/cancel/error) from the authoritative DB flags.
        if (settled.length && settled.every((r) => r.status === 'rejected')) {
          throw (settled[0] as PromiseRejectedResult).reason;
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
      if (firstFailure) throw firstFailure;
      throw new Error(
        `${failedBatches} enrichment batch(es) failed — resume the job to retry the affected domains.`
      );
    }

    return finalizeStep(input, batchResults);
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
  const batchSize = resolveBatchSize(ctx.pipelineMode);

  return {
    pipelineMode: ctx.pipelineMode,
    batchSize,
    batches: chunkDomains(allDomains, batchSize),
  };
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
reconcileStagesStep.maxRetries = 0; // best-effort (wrapped in try/catch above)
finalizeStep.maxRetries = 2;
// Recording the failure state must itself be resilient — this is the last line of
// defense against a silent zombie job, so retry it harder than the work steps.
handleWorkflowFailureStep.maxRetries = 3;
