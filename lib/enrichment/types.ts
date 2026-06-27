export type ExecutionRunner = 'pm2' | 'vercel';

export type PipelineMode = 'shopping_audit' | 'standard';

export type EnrichmentContext = {
  jobId: string;
  agencyId: string;
  clientId: number;
  clientSlug: string;
  pipelineMode: PipelineMode;
  apiKeys: { openai: string; serper: string; trykitt?: string };
  options: Record<string, unknown>;
  auditFeatures?: Record<string, unknown>;
  stages?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
};

export type ChildBatchInput = {
  jobId: string;
  agencyId: string;
  batchDomains: string[];
  batchIndex: number;
  pipelineMode: PipelineMode;
};

export type ParentWorkflowInput = {
  jobId: string;
  agencyId: string;
};

export const BATCH_SIZE = 100;
export const CHILD_WAVE_CONCURRENCY = 15;
