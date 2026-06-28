import { NextResponse } from 'next/server';

/**
 * GET /internal/enrichment/reap
 *
 * Watchdog endpoint for stalled Vercel-runner enrichment jobs. Invoked by Vercel Cron
 * (see vercel.json) and recovers jobs stuck at status='running' with no progress,
 * flipping them to a resumable paused-with-error state.
 *
 * Auth: accepts Vercel Cron's `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is
 * set, or `WORKFLOW_TRIGGER_SECRET` for manual invocation. If neither is configured
 * (local/dev), it runs unauthenticated — mirroring the start route's leniency.
 */
function authorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const triggerSecret = process.env.WORKFLOW_TRIGGER_SECRET;
  if (!cronSecret && !triggerSecret) return true;

  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (cronSecret && token === cronSecret) return true;
  if (triggerSecret && token === triggerSecret) return true;
  return false;
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const enrichment = await import('@server/enrichment/index.js');
    const result = await enrichment.reapStalledWorkflows({});
    return NextResponse.json({ status: 'ok', ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[reap] sweep failed:', message);
    return NextResponse.json({ status: 'error', error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
