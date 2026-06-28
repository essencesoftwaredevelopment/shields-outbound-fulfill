import type { PipelineMode } from '@/lib/enrichment/types';
import {
  BATCH_SIZE,
  SHOPPING_AUDIT_BATCH_SIZE,
} from '@/lib/enrichment/types';

export function resolveBatchSize(pipelineMode: PipelineMode): number {
  return pipelineMode === 'shopping_audit' ? SHOPPING_AUDIT_BATCH_SIZE : BATCH_SIZE;
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

export type BatchPlan = {
  batches: string[][];
  pipelineMode: PipelineMode;
  batchSize: number;
};
