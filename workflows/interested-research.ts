/**
 * Vercel Workflow — durable research run for one interested-reply draft.
 *
 * Triggered from the Express Instantly path (webhook or sync reconcile) via
 * POST /internal/interested-research/start after a draft shell is inserted at
 * status='researching'. Single linear run per draft — no fan-out:
 *
 *   hydrate → homepage + Serper research → synthesize brief (persisted on the
 *   draft) → external popup URL (Essence/Vulcan, stays external by design) →
 *   generate reply with the brief → promote to pending_review + ntfy.
 *
 * This is deliberately NOT part of the enrichment parent/child pipeline: the
 * reply path is per-event, reply-aware, and human-gated, while enrichment is
 * batch CSV work. Only libraries are shared (server/src/services/*).
 *
 * The draft row is the idempotency anchor: every step re-checks
 * status='researching' and a superseded draft (new inbound event cancelled it,
 * lead flipped to not-interested, duplicate trigger) ends the run cleanly via
 * RESEARCH_DRAFT_SUPERSEDED instead of failing or resurrecting old state.
 */

type ResearchModule = typeof import('../server/src/services/interestedResearch/index.js');

async function loadResearch(): Promise<ResearchModule> {
  return import('../server/src/services/interestedResearch/index.js');
}

export interface InterestedResearchInput {
  draftId: number;
  agencyId: string;
  isFollowUp?: boolean;
  /** When true, finalize skips the ntfy push (review-page regenerate). */
  skipNtfy?: boolean;
}

export async function interestedResearchWorkflow(input: InterestedResearchInput) {
  'use workflow';

  try {
    const ctx = await hydrateStep(input);

    // Research sources are independent and best-effort — either may be null.
    const [homepage, serper] = await Promise.all([
      homepageStep(input),
      serperStep(input),
    ]);

    const brief = await synthesizeBriefStep(input, homepage, serper);
    const popup = await popupStep(input);
    const result = await finalizeStep(input, popup?.auditPreviewUrl ?? null);

    return {
      status: 'promoted' as const,
      draftId: ctx.draftId,
      reviewUrl: result.reviewUrl,
      hadBrief: brief !== null,
    };
  } catch (err) {
    const errorInfo = toErrorInfo(err);
    if (errorInfo.code === 'RESEARCH_DRAFT_SUPERSEDED') {
      // Duplicate trigger or the draft moved on (cancelled / superseded by a
      // newer event) — expected control flow, never touch the row.
      return { status: 'superseded' as const, draftId: input.draftId };
    }
    // Keystone failure handler: without it a crash strands the draft at
    // 'researching' and the lead silently never gets a reviewed reply.
    await handleFailureStep(input, errorInfo);
    // Re-throw so the Vercel run is marked failed for alerting/observability.
    throw err;
  }
}

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

async function hydrateStep(input: InterestedResearchInput) {
  'use step';

  const research = await loadResearch();
  return research.hydrateResearchContext(input);
}

async function homepageStep(input: InterestedResearchInput) {
  'use step';

  const research = await loadResearch();
  try {
    return await research.runHomepageResearch(input);
  } catch (err) {
    if (toErrorInfo(err).code === 'RESEARCH_DRAFT_SUPERSEDED') throw err;
    // Research sources are best-effort — a flaky site must not fail the run.
    console.warn('[interested-research] homepage step failed:', toErrorInfo(err).message);
    return null;
  }
}

async function serperStep(input: InterestedResearchInput) {
  'use step';

  const research = await loadResearch();
  try {
    return await research.runSerperResearch(input);
  } catch (err) {
    if (toErrorInfo(err).code === 'RESEARCH_DRAFT_SUPERSEDED') throw err;
    console.warn('[interested-research] serper step failed:', toErrorInfo(err).message);
    return null;
  }
}

async function synthesizeBriefStep(
  input: InterestedResearchInput,
  homepage: Awaited<ReturnType<ResearchModule['runHomepageResearch']>>,
  serper: Awaited<ReturnType<ResearchModule['runSerperResearch']>>
) {
  'use step';

  const research = await loadResearch();
  try {
    return await research.synthesizeResearchBrief({ ...input, homepage, serper });
  } catch (err) {
    if (toErrorInfo(err).code === 'RESEARCH_DRAFT_SUPERSEDED') throw err;
    // A failed brief degrades to the pre-research draft quality, not a dead lead.
    console.warn('[interested-research] brief synthesis failed:', toErrorInfo(err).message);
    return null;
  }
}

async function popupStep(input: InterestedResearchInput) {
  'use step';

  const research = await loadResearch();
  try {
    return await research.runPopupGeneration(input);
  } catch (err) {
    if (toErrorInfo(err).code === 'RESEARCH_DRAFT_SUPERSEDED') throw err;
    // Popup is external and optional — the inline path treats it the same way.
    console.warn('[interested-research] popup step failed:', toErrorInfo(err).message);
    return null;
  }
}

async function finalizeStep(
  input: InterestedResearchInput,
  auditPreviewUrl: string | null
) {
  'use step';

  const research = await loadResearch();
  return research.finalizeResearchDraft({
    ...input,
    auditPreviewUrl,
    isFollowUp: Boolean(input.isFollowUp),
    skipNtfy: Boolean(input.skipNtfy),
  });
}

async function handleFailureStep(
  input: InterestedResearchInput,
  errorInfo: { message: string; code: string | null }
) {
  'use step';

  const research = await loadResearch();
  return research.handleResearchFailure(input, errorInfo);
}

// The superseded guard throws INTENTIONALLY — retrying only delays the clean stop.
hydrateStep.maxRetries = 0;
// Research sources already degrade to null inside the step; one retry covers
// transient network blips without double-spending Serper/fetch budgets.
homepageStep.maxRetries = 1;
serperStep.maxRetries = 1;
// A retry would re-bill the OpenAI call; the step degrades to null on failure.
synthesizeBriefStep.maxRetries = 0;
// Popup generation has its own internal retry/backoff (mirrors the inline path).
popupStep.maxRetries = 0;
// Finalize is guarded by status='researching', so a retry after a mid-step crash
// either completes the promotion or stops as superseded — never double-notifies
// with two different tokens for the same open draft.
finalizeStep.maxRetries = 1;
// Last line of defense against a draft stranded at 'researching'.
handleFailureStep.maxRetries = 3;
