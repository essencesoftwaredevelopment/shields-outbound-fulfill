import type { PipelineMode } from './types';

export const DEFAULT_BATCH_SIZE = 100;
/** Smaller batches for shopping audit — keeps each workflow step under platform maxDuration. */
export const DEFAULT_SHOPPING_AUDIT_BATCH_SIZE = 25;
export const DEFAULT_WAVE_CONCURRENCY = 5;

/**
 * `jobs.options` as handed over by the JSDoc-typed server layer — treat as
 * fully untrusted and narrow key-by-key.
 */
type JobOptions = unknown;

function jobOption(options: JobOptions, key: string): unknown {
  if (options && typeof options === 'object') {
    return (options as Record<string, unknown>)[key];
  }
  return undefined;
}

/** Strict positive-int coercion: numeric strings allowed, anything else → null. */
function coercePositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * Batch size precedence: `jobs.options.batchSize` (per-job override) →
 * env `SHOPPING_AUDIT_BATCH_SIZE` / `ENRICHMENT_BATCH_SIZE` → 25 / 100.
 *
 * Env is read per call, not at module load: callers snapshot the resolved value
 * into a durable step result (the batch plan), so a mid-run env change or
 * redeploy can never change wave chunking under a replaying workflow.
 */
export function resolveBatchSize(
  pipelineMode: PipelineMode,
  options?: JobOptions
): number {
  const fromJob = coercePositiveInt(jobOption(options, 'batchSize'));
  if (fromJob !== null) return fromJob;

  const fromEnv = coercePositiveInt(
    pipelineMode === 'shopping_audit'
      ? process.env.SHOPPING_AUDIT_BATCH_SIZE
      : process.env.ENRICHMENT_BATCH_SIZE
  );
  if (fromEnv !== null) return fromEnv;

  return pipelineMode === 'shopping_audit'
    ? DEFAULT_SHOPPING_AUDIT_BATCH_SIZE
    : DEFAULT_BATCH_SIZE;
}

/**
 * Children spawned per wave. Precedence: `jobs.options.waveConcurrency` →
 * env `ENRICHMENT_CHILD_WAVE_CONCURRENCY` → 5. Same snapshot rule as
 * {@link resolveBatchSize}.
 */
export function resolveWaveConcurrency(options?: JobOptions): number {
  const fromJob = coercePositiveInt(jobOption(options, 'waveConcurrency'));
  if (fromJob !== null) return fromJob;

  const fromEnv = coercePositiveInt(process.env.ENRICHMENT_CHILD_WAVE_CONCURRENCY);
  if (fromEnv !== null) return fromEnv;

  return DEFAULT_WAVE_CONCURRENCY;
}

export function chunkDomains(
  domains: string[],
  batchSize: number
): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < domains.length; i += batchSize) {
    batches.push(domains.slice(i, i + batchSize));
  }
  return batches;
}

export type PlannedBatch = {
  domains: string[];
  resumeStagesOnly: boolean;
};

/**
 * Two-list batch plan (C1): pending domains get the full pipeline; domains
 * whose contacts still have queue work (but are past 'pending') get
 * resume-stages-only batches. A domain in both lists is scheduled ONCE, as a
 * full-pipeline batch — that pass runs the queue stages anyway, and double
 * scheduling would race two children on the same domain's contacts.
 */
export function buildBatchLists(
  pendingDomains: string[],
  resumeStageDomains: string[],
  batchSize: number
): PlannedBatch[] {
  const pendingSet = new Set(pendingDomains);
  const resumeOnly = resumeStageDomains.filter((d) => !pendingSet.has(d));
  return [
    ...chunkDomains(pendingDomains, batchSize).map((domains) => ({
      domains,
      resumeStagesOnly: false,
    })),
    ...chunkDomains(resumeOnly, batchSize).map((domains) => ({
      domains,
      resumeStagesOnly: true,
    })),
  ];
}

export type BatchPlan = {
  batches: PlannedBatch[];
  pipelineMode: PipelineMode;
  batchSize: number;
  waveConcurrency: number;
};
