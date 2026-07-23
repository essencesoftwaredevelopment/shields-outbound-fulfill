/**
 * Vercel Workflow — one batch of domains.
 * Shopping audit runs as separate steps so each stays under maxDuration.
 *
 * `enrichmentChildRun` is the entry the parent spawns via `start()`: each batch
 * becomes an independent run with its own event log, and completion is reported
 * back through the parent's completion hook instead of a thrown error.
 */
import { resumeHook } from 'workflow/api';
import type { ChildBatchInput, ShoppingAuditBatchState } from '@/lib/enrichment/types';
import {
  buildChildFailurePayload,
  type ChildCompletionPayload,
} from '@/lib/enrichment/childCompletion';

type EnrichmentModule = typeof import('../server/src/enrichment/index.js');

async function loadEnrichment(): Promise<EnrichmentModule> {
  return import('../server/src/enrichment/index.js');
}

export type ChildRunInput = ChildBatchInput & {
  /** Token of the parent's completion hook for this batch. */
  completionToken: string;
};

/**
 * True child run: never throws pipeline errors to the platform. Success and
 * failure alike are delivered to the parent as a completion-hook payload, so a
 * failed batch can never take down in-flight siblings or the parent run.
 */
export async function enrichmentChildRun(input: ChildRunInput) {
  'use workflow';

  // Strip the token so step arguments stay identical to the pre-hook shape.
  const { completionToken, ...batchInput } = input;

  let payload: ChildCompletionPayload;
  try {
    const result = await enrichmentChildWorkflow(batchInput);
    payload = {
      batchIndex: input.batchIndex,
      status: 'ok',
      summary: {
        domainCount: result.domainCount,
        auditSignals: result.auditSignals,
      },
    };
  } catch (err) {
    // 'inactive' (job paused/cancelled) vs 'failed' — the parent never inspects
    // errors (B2), so the classification must happen here.
    payload = buildChildFailurePayload(input.batchIndex, err);
  }

  await reportCompletionStep(completionToken, payload);
  return payload;
}

async function reportCompletionStep(
  completionToken: string,
  payload: ChildCompletionPayload
) {
  'use step';

  await resumeHook(completionToken, payload);
}

// The parent is suspended on this hook — delivery must survive transient DB or
// queue blips. If it still fails (parent run gone, hook disposed), throwing is
// correct: the batch outcome is durable in the DB, nobody is listening for the
// payload, and a failed child run is the honest breadcrumb for the Workflow UI.
// The job itself is recovered by the stall reaper, as with any lost run.
reportCompletionStep.maxRetries = 5;

export async function enrichmentChildWorkflow(input: ChildBatchInput) {
  'use workflow';

  try {
    let auditSummary: Awaited<
      ReturnType<EnrichmentModule['finalizeShoppingAuditStageBatch']>
    > | null = null;

    if (input.pipelineMode === 'shopping_audit') {
      // Serper-first: bare-domain query + on-demand catalog reverse match,
      // then the waterfall. Only matched domains move forward to enrichment.
      let auditState = await serperShoppingStep(input, null);
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
    // Never swallow: re-throw so enrichmentChildRun classifies the failure into
    // the completion payload. Log the batch index for diagnostics.
    console.error(
      `[enrichment-child] batch ${input.batchIndex} failed:`,
      err instanceof Error ? err.message : String(err)
    );
    throw err;
  }
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
serperShoppingStep.maxRetries = 0;
signalWaterfallStep.maxRetries = 0;
finalizeShoppingAuditStep.maxRetries = 0;
// Standard stages re-query the DB queue each run, so a retry only processes still-pending
// rows (already-done items drop out) — safe to retry through transient provider failures.
foundersStep.maxRetries = 2;
emailsStep.maxRetries = 2;
verificationStep.maxRetries = 2;
personalizationStep.maxRetries = 2;
