import { NextResponse } from 'next/server';
import { start } from 'workflow/api';
import { callAnalysisWorkflow } from '@/workflows/call-analysis';

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/**
 * POST /internal/call-analysis/start
 * Body: { recordingId, agencyId }
 *
 * Called by Express (Fathom webhook / backfill) after storing the recording in
 * call_recordings. Mirrors /internal/interested-research/start.
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

  let body: { recordingId?: number; agencyId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const recordingId = Number(body.recordingId);
  const agencyId = String(body.agencyId || '').trim();
  if (!Number.isFinite(recordingId) || recordingId <= 0 || !agencyId) {
    return NextResponse.json({ error: 'recordingId and agencyId required' }, { status: 400 });
  }

  const run = await start(callAnalysisWorkflow, [{ recordingId, agencyId }]);

  const callAnalysis = await import('@server/services/callAnalysis/index.js');
  await callAnalysis.attachCallAnalysisRunId({ recordingId, agencyId, workflowRunId: run.runId });

  return NextResponse.json({ status: 'started', vercelRunId: run.runId, recordingId, agencyId });
}
