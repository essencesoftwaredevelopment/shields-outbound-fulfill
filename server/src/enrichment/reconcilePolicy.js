/**
 * Vercel child batches run in separate isolates, so their in-memory debouncers
 * cannot coordinate. The parent workflow already reconciles after each wave and
 * again at finalize; child-triggered reconciliations only duplicate full-cohort
 * scans.
 *
 * PM2 keeps its live reconciliation behaviour because it has no parent-wave
 * coordinator.
 */
export function shouldScheduleChildReconcile(ctx) {
    const runner = String(ctx?.options?.executionRunner || 'pm2').toLowerCase();
    return runner !== 'vercel';
}

/**
 * Throttle for the Vercel liveness ping that replaces the suppressed reconcile
 * tick. Must stay well under `reapStalledWorkflows`' 20-minute stall window;
 * 30s keeps `jobs.updated_at` fresh at ~2 indexed UPDATEs per minute per child.
 */
export const CHILD_HEARTBEAT_MS = 30_000;
