/**
 * Vercel Workflow — one batch of domains.
 * Shopping audit runs as separate steps so each stays under maxDuration.
 */
import type { ChildBatchInput, ShoppingAuditBatchState } from '@/lib/enrichment/types';

type EnrichmentModule = typeof import('../server/src/enrichment/index.js');

async function loadEnrichment(): Promise<EnrichmentModule> {
  return import('../server/src/enrichment/index.js');
}

export async function enrichmentChildWorkflow(input: ChildBatchInput) {
  'use workflow';

  try {
    let auditSummary: Awaited<
      ReturnType<EnrichmentModule['finalizeShoppingAuditStageBatch']>
    > | null = null;

    if (input.pipelineMode === 'shopping_audit') {
      let auditState = await shopifyCatalogStep(input);
      auditState = await heroSelectionStep(input, auditState);
      auditState = await serperShoppingStep(input, auditState);
      auditState = await signalWaterfallStep(input, auditState);
      auditSummary = await finalizeShoppingAuditStep(input, auditState);
    }

    await foundersStep(input);
    await emailsStep(input);
    await verificationStep(input);
    await personalizationStep(input);

    return {
      batchIndex: input.batchIndex,
      domainCount: input.batchDomains.length,
      auditSignals: auditSummary?.stats?.signals ?? 0,
    };
  } catch (err) {
    // Never swallow: re-throw so the parent's handleWorkflowFailureStep writes the
    // authoritative job state. Log the batch index for diagnostics. (Per-batch
    // isolation — letting healthy batches finish — is a separate change: Promise.all
    // -> allSettled in the parent.)
    console.error(
      `[enrichment-child] batch ${input.batchIndex} failed:`,
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }
}

async function shopifyCatalogStep(input: ChildBatchInput) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runShoppingAuditStageBatch(
    ctx,
    input.batchDomains,
    'shopifyCatalog',
    null,
    { batchIndex: input.batchIndex }
  );
}

async function heroSelectionStep(
  input: ChildBatchInput,
  state: ShoppingAuditBatchState | null
) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runShoppingAuditStageBatch(
    ctx,
    input.batchDomains,
    'heroSelection',
    state,
    { batchIndex: input.batchIndex }
  );
}

async function serperShoppingStep(
  input: ChildBatchInput,
  state: ShoppingAuditBatchState | null
) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runShoppingAuditStageBatch(
    ctx,
    input.batchDomains,
    'serperShopping',
    state,
    { batchIndex: input.batchIndex }
  );
}

async function signalWaterfallStep(
  input: ChildBatchInput,
  state: ShoppingAuditBatchState | null
) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runShoppingAuditStageBatch(
    ctx,
    input.batchDomains,
    'signalWaterfall',
    state,
    { batchIndex: input.batchIndex }
  );
}

async function finalizeShoppingAuditStep(
  input: ChildBatchInput,
  state: ShoppingAuditBatchState | null
) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.finalizeShoppingAuditStageBatch(ctx, state ?? {});
}

async function foundersStep(input: ChildBatchInput) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runFoundersBatch(ctx, input.batchDomains, {
    batchIndex: input.batchIndex,
  });
}

async function emailsStep(input: ChildBatchInput) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runEmailsBatch(ctx, input.batchDomains, {
    batchIndex: input.batchIndex,
  });
}

async function verificationStep(input: ChildBatchInput) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runVerificationBatch(ctx, input.batchDomains, {
    batchIndex: input.batchIndex,
  });
}

async function personalizationStep(input: ChildBatchInput) {
  'use step';

  const enrichment = await loadEnrichment();
  const ctx = await enrichment.hydrateJobContext(input.jobId, input.agencyId);
  await enrichment.assertJobActive(input.jobId, input.agencyId);
  return enrichment.runPersonalizationBatch(ctx, input.batchDomains, {
    batchIndex: input.batchIndex,
  });
}

// Shopping-audit steps thread serializable state between them and re-call Serper/Shopify
// on re-run; leave at 0 until per-item idempotency (no double-charge) is verified.
shopifyCatalogStep.maxRetries = 0;
heroSelectionStep.maxRetries = 0;
serperShoppingStep.maxRetries = 0;
signalWaterfallStep.maxRetries = 0;
finalizeShoppingAuditStep.maxRetries = 0;
// Standard stages re-query the DB queue each run, so a retry only processes still-pending
// rows (already-done items drop out) — safe to retry through transient provider failures.
foundersStep.maxRetries = 2;
emailsStep.maxRetries = 2;
verificationStep.maxRetries = 2;
personalizationStep.maxRetries = 2;
