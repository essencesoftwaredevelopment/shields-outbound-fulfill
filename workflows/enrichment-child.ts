/**
 * Vercel Workflow — one batch of domains (up to 100).
 * Coarse steps; per-lead concurrency lives inside each server stage runner.
 */
import type { ChildBatchInput } from '@/lib/enrichment/types';

type EnrichmentModule = typeof import('../server/src/enrichment/index.js');

async function loadEnrichment(): Promise<EnrichmentModule> {
  return import('../server/src/enrichment/index.js');
}

export async function enrichmentChildWorkflow(input: ChildBatchInput) {
  'use workflow';

  const auditSummary = await shoppingAuditStep(input);
  await foundersStep(input);
  await emailsStep(input);
  await verificationStep(input);
  await personalizationStep(input);

  return {
    batchIndex: input.batchIndex,
    domainCount: input.batchDomains.length,
    auditSignals:
      auditSummary && 'stats' in auditSummary && auditSummary.stats
        ? (auditSummary.stats as { signals?: number }).signals ?? 0
        : 0,
  };
}

async function shoppingAuditStep(input: ChildBatchInput) {
  'use step';

  if (input.pipelineMode !== 'shopping_audit') {
    return null;
  }

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runShoppingAuditBatch(ctx, input.batchDomains);
}

async function foundersStep(input: ChildBatchInput) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runFoundersBatch(ctx, input.batchDomains);
}

async function emailsStep(input: ChildBatchInput) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runEmailsBatch(ctx, input.batchDomains);
}

async function verificationStep(input: ChildBatchInput) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runVerificationBatch(ctx, input.batchDomains);
}

async function personalizationStep(input: ChildBatchInput) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runPersonalizationBatch(ctx, input.batchDomains);
}

shoppingAuditStep.maxRetries = 0;
foundersStep.maxRetries = 0;
emailsStep.maxRetries = 0;
verificationStep.maxRetries = 0;
personalizationStep.maxRetries = 0;
