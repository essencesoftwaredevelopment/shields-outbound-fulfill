import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { interestedResearchWorkflow } from '@/workflows/interested-research';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * POST /internal/interested-research/start
 * Body: { draftId, agencyId, isFollowUp? }
 *
 * Called by Express (interested autoresponder path) after inserting a draft
 * shell at status='researching'. Mirrors /internal/enrichment/start.
 */
export async function POST(request: Request) {
  const secret = process.env.WORKFLOW_TRIGGER_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== secret) {
      return unauthorized();
    }
  }

  let body: { draftId?: number; agencyId?: string; isFollowUp?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const draftId = Number(body.draftId);
  const agencyId = String(body.agencyId || '').trim();
  if (!Number.isFinite(draftId) || draftId <= 0 || !agencyId) {
    return NextResponse.json(
      { error: 'draftId and agencyId required' },
      { status: 400 }
    );
  }

  const run = await start(interestedResearchWorkflow, [
    { draftId, agencyId, isFollowUp: Boolean(body.isFollowUp) },
  ]);

  return NextResponse.json({
    status: 'started',
    vercelRunId: run.runId,
    draftId,
    agencyId,
  });
}
