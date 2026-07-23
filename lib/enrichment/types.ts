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
  /** Set by /internal/enrichment/start — persisted after guardWorkflowStart passes. */
  workflowRunId?: string;
};

/** Serializable shopping-audit state passed between child workflow steps.
 * Serper-first: catalog snapshots are persisted to DB inside the serper stage
 * and never carried in step state; observations hold slim cards only.
 */
export type ShoppingAuditBatchState = {
  stats: {
    serperMatched: number;
    serperClean: number;
    serperAmbiguous: number;
    serperNone: number;
    signals: number;
    headless: number;
    cost: number;
  };
  companyIdByDomain: Record<string, number>;
  observations: unknown[];
  signalByDomain: Record<string, unknown>;
  qualifiedDomains: string[];
};
