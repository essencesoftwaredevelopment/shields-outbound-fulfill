import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { warmFollowUpWorkflow } from '@/workflows/warm-follow-up';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * POST /internal/warm-follow-up/start
 * Body: { runId, agencyId }
 *
 * Called by Express after inserting a follow_up_generation_runs row
 * at status='running'.
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

  let body: { runId?: number; agencyId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const runId = Number(body.runId);
  const agencyId = String(body.agencyId || '').trim();
  if (!Number.isFinite(runId) || runId <= 0 || !agencyId) {
    return NextResponse.json(
      { error: 'runId and agencyId required' },
      { status: 400 }
    );
  }

  const run = await start(warmFollowUpWorkflow, [{ runId, agencyId }]);

  const generation = await import('@server/services/warmFollowUpGeneration/index.js');
  await generation.attachWorkflowRunId({
    runId,
    agencyId,
    workflowRunId: run.runId,
  });

  return NextResponse.json({
    status: 'started',
    vercelRunId: run.runId,
    runId,
    agencyId,
  });
}
