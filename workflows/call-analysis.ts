/**
 * Vercel Workflow — AI analysis of one recorded call (Fathom) into the sales log.
 *
 * Triggered from Express (Fathom webhook or backfill) via
 * POST /internal/call-analysis/start after the recording is stored as a
 * call_recordings row (server/src/services/callAnalysis):
 *
 *   match → analyze (one model call on the transcript) → apply to sales_calls
 *
 * The call_recordings row is the idempotency anchor: each step re-reads it and
 * skips work already done, so retries and duplicate triggers are safe. A
 * recording that matches no prospect (team meetings, client calls) ends after
 * the match step with no AI cost.
 */

type CallAnalysisModule = typeof import('../server/src/services/callAnalysis/index.js');

async function loadCallAnalysis(): Promise<CallAnalysisModule> {
  return import('../server/src/services/callAnalysis/index.js');
}

export interface CallAnalysisInput {
  recordingId: number;
  agencyId: string;
}

export async function callAnalysisWorkflow(input: CallAnalysisInput) {
  'use workflow';

  try {
    const match = await matchStep(input);
    if (match.status !== 'matched') {
      return { status: 'unmatched' as const, recordingId: input.recordingId };
    }
    await analyzeStep(input);
    const applied = await applyStep(input);
    return { status: 'applied' as const, recordingId: input.recordingId, changed: applied.changed };
  } catch (err) {
    await failStep(input, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function matchStep(input: CallAnalysisInput) {
  'use step';

  const callAnalysis = await loadCallAnalysis();
  return callAnalysis.matchRecording(input);
}

async function analyzeStep(input: CallAnalysisInput) {
  'use step';

  const callAnalysis = await loadCallAnalysis();
  return callAnalysis.analyzeRecording(input);
}

async function applyStep(input: CallAnalysisInput) {
  'use step';

  const callAnalysis = await loadCallAnalysis();
  return callAnalysis.applyRecordingAnalysis(input);
}

async function failStep(input: CallAnalysisInput, message: string) {
  'use step';

  const callAnalysis = await loadCallAnalysis();
  await callAnalysis.markRecordingFailed({ ...input, message });
}
