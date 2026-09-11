/**
 * Vercel Workflow — durable AI generation for one warm follow-up.
 *
 * Triggered from Express (preview UI or the follow-up worker) via
 * POST /internal/warm-follow-up/start after a follow_up_generation_runs
 * row is inserted at status='running'.
 *
 *   hydrate → load existing research brief (optional) → generate copy →
 *   preview complete | autosend
 *
 * Missing research never fails the run. A cancelled/completed row ends
 * cleanly via a `{ status: 'cancelled' }` sentinel.
 */

import {
  isWarmFollowUpCancelledError,
  isWarmFollowUpCancelledResult,
  toWarmFollowUpErrorInfo,
  warmFollowUpCancelledResult,
  type WarmFollowUpCancelledResult,
} from '@/lib/warm-follow-up/cancelled';

type GenerationModule = typeof import('../server/src/services/warmFollowUpGeneration/index.js');

async function loadGeneration(): Promise<GenerationModule> {
  return import('../server/src/services/warmFollowUpGeneration/index.js');
}

export interface WarmFollowUpInput {
  runId: number;
  agencyId: string;
}

export async function warmFollowUpWorkflow(input: WarmFollowUpInput) {
  'use workflow';

  try {
    const ctx = await hydrateStep(input);
    if (isWarmFollowUpCancelledResult(ctx)) {
      return { status: 'cancelled' as const, runId: input.runId };
    }

    const brief = await briefStep(input);
    if (isWarmFollowUpCancelledResult(brief)) {
      return { status: 'cancelled' as const, runId: input.runId };
    }

    const generated = await generateStep(input, brief);
    if (isWarmFollowUpCancelledResult(generated)) {
      return { status: 'cancelled' as const, runId: input.runId };
    }

    const finalized = await finalizeStep(input);
    if (isWarmFollowUpCancelledResult(finalized)) {
      return { status: 'cancelled' as const, runId: input.runId };
    }

    return {
      status: 'completed' as const,
      runId: input.runId,
      mode: ctx.mode,
      usedResearchBrief: Boolean(generated?.usedResearchBrief),
      usedTemplateFallback: Boolean(generated?.usedTemplateFallback),
    };
  } catch (err) {
    const errorInfo = toWarmFollowUpErrorInfo(err);
    if (isWarmFollowUpCancelledError(errorInfo)) {
      return { status: 'cancelled' as const, runId: input.runId };
    }
    await handleFailureStep(input, errorInfo);
    throw err;
  }
}

async function hydrateStep(input: WarmFollowUpInput) {
  'use step';

  const generation = await loadGeneration();
  try {
    return await generation.hydrateGenerationContext(input);
  } catch (err) {
    if (isWarmFollowUpCancelledError(err)) return warmFollowUpCancelledResult();
    throw err;
  }
}

async function briefStep(
  input: WarmFollowUpInput
): Promise<Record<string, unknown> | null | WarmFollowUpCancelledResult> {
  'use step';

  const generation = await loadGeneration();
  try {
    return await generation.loadResearchBriefForRun(input);
  } catch (err) {
    if (isWarmFollowUpCancelledError(err)) return warmFollowUpCancelledResult();
    console.warn('[warm-follow-up] brief step failed:', toWarmFollowUpErrorInfo(err).message);
    return null;
  }
}

async function generateStep(
  input: WarmFollowUpInput,
  researchBrief: Record<string, unknown> | null
) {
  'use step';

  const generation = await loadGeneration();
  try {
    return await generation.generateFollowUpCopy({
      ...input,
      researchBrief,
    });
  } catch (err) {
    if (isWarmFollowUpCancelledError(err)) return warmFollowUpCancelledResult();
    throw err;
  }
}

async function finalizeStep(input: WarmFollowUpInput) {
  'use step';

  const generation = await loadGeneration();
  try {
    return await generation.sendGeneratedFollowUp(input);
  } catch (err) {
    if (isWarmFollowUpCancelledError(err)) return warmFollowUpCancelledResult();
    throw err;
  }
}

async function handleFailureStep(
  input: WarmFollowUpInput,
  errorInfo: ReturnType<typeof toWarmFollowUpErrorInfo>
) {
  'use step';

  const generation = await loadGeneration();
  await generation.failGenerationRun({ ...input, errorInfo });
}
