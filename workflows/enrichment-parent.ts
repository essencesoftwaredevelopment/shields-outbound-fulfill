/**
 * Vercel Workflow — parent orchestrator for enrichment jobs.
 */
import { start } from 'workflow/api';
import {
  BATCH_SIZE,
  CHILD_WAVE_CONCURRENCY,
  type ParentWorkflowInput,
} from '@/lib/enrichment/types';
import { enrichmentChildWorkflow } from './enrichment-child';

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!items.length) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index], index);
      }
    }
  );
  await Promise.all(runners);
  return results;
}

type EnrichmentModule = typeof import('../server/src/enrichment/index.js');

async function loadEnrichment(): Promise<EnrichmentModule> {
  return import('../server/src/enrichment/index.js');
}

export async function enrichmentParentWorkflow(input: ParentWorkflowInput) {
  'use workflow';

  await hydrateAndStartStep(input);
  await domainPrepStep(input);
  const batchResults = await spawnChildBatchesStep(input);
  return finalizeStep(input, batchResults);
}

async function hydrateAndStartStep(input: ParentWorkflowInput) {
  'use step';

  const enrichment = await loadEnrichment();
  await enrichment.guardWorkflowStart(input.jobId, input.agencyId);
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);

  await enrichment.markJobRunning(input.jobId, input.agencyId);
  await enrichment.setWorkflowMeta(input.jobId, input.agencyId, {
    executionRunner: 'vercel',
  });

  return { pipelineMode: ctx.pipelineMode };
}

async function domainPrepStep(input: ParentWorkflowInput) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runDomainPrep(ctx);
}

async function spawnChildBatchesStep(input: ParentWorkflowInput) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);

  const allDomains = await enrichment.listPendingDomainNames(input.jobId);
  const batches: string[][] = [];
  for (let i = 0; i < allDomains.length; i += BATCH_SIZE) {
    batches.push(allDomains.slice(i, i + BATCH_SIZE));
  }

  if (!batches.length) {
    return [];
  }

  const childRunIds: string[] = [];
  const results = await mapWithConcurrency(
    batches,
    CHILD_WAVE_CONCURRENCY,
    async (batchDomains, batchIndex) => {
      await enrichment.assertJobActive(input.jobId, input.agencyId);
      const run = await start(enrichmentChildWorkflow, [
        {
          jobId: input.jobId,
          agencyId: input.agencyId,
          batchDomains,
          batchIndex,
          pipelineMode: ctx.pipelineMode,
        },
      ]);
      childRunIds.push(run.runId);
      return run.returnValue;
    }
  );

  await enrichment.setWorkflowMeta(input.jobId, input.agencyId, {
    childRunIds,
  });

  return results;
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

hydrateAndStartStep.maxRetries = 0;
domainPrepStep.maxRetries = 0;
spawnChildBatchesStep.maxRetries = 0;
finalizeStep.maxRetries = 0;
