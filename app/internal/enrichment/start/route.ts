import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { enrichmentParentWorkflow } from '@/workflows/enrichment-parent';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * POST /internal/enrichment/start
 * Body: { jobId, agencyId }
 *
 * Called by Express after job creation when executionRunner=vercel.
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

  let body: { jobId?: string; agencyId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { jobId, agencyId } = body;
  if (!jobId || !agencyId) {
    return NextResponse.json({ error: 'jobId and agencyId required' }, { status: 400 });
  }

  const run = await start(enrichmentParentWorkflow, [{ jobId, agencyId }]);

  try {
    const enrichment = await import('@server/enrichment/index.js');
    await enrichment.setWorkflowMeta(jobId, agencyId, {
      workflowRunId: run.runId,
    });
  } catch (error) {
    console.warn('[enrichment/start] failed to persist workflowRunId', error);
  }

  return NextResponse.json({
    status: 'started',
    workflowRunId: run.runId,
    jobId,
    agencyId,
  });
}
