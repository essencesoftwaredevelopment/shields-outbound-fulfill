/**
 * followUpWorker.js
 *
 * Persistent worker that runs the follow-up sender twice per day at
 * configurable times. Mirrors the shape of instantlySyncWorker.js.
 *
 * Env configuration:
 *   FOLLOWUP_SCHEDULE_TIMES  Comma-separated HH:MM times in 24h format (default: "09:00,14:00")
 *   FOLLOWUP_TIMEZONE        IANA timezone for schedule times (default: "UTC")
 *   FOLLOWUP_BATCH_SIZE      Max prospects per client per pass (default: 50)
 *   FOLLOWUP_CONCURRENCY     Parallel client runs per pass (default: 2)
 *   FOLLOWUP_DRY_RUN         Set to "true" to log without sending (default: false)
 */

import pLimit from 'p-limit';
import { runFollowUpsForClient } from '../services/followUpSender.js';
import { listInstantlySyncClients } from '../services/instantlyState.js';
import { msUntilNextRun, parseScheduleTimes } from './followUpSchedule.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const SCHEDULE_TIMES_RAW = process.env.FOLLOWUP_SCHEDULE_TIMES || '09:00,14:00';
const TIMEZONE = process.env.FOLLOWUP_TIMEZONE || 'UTC';
const BATCH_SIZE = Math.max(parseInt(process.env.FOLLOWUP_BATCH_SIZE || '50', 10) || 50, 1);
const CONCURRENCY = Math.max(parseInt(process.env.FOLLOWUP_CONCURRENCY || '2', 10) || 2, 1);
const DRY_RUN = process.env.FOLLOWUP_DRY_RUN === 'true';

const SCHEDULE_TIMES = parseScheduleTimes(SCHEDULE_TIMES_RAW);

// ─── Pass orchestration ───────────────────────────────────────────────────────

let shutdownRequested = false;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPass() {
    const clients = await listInstantlySyncClients();
    console.log(`[follow-up-worker] Found ${clients.length} client(s) with Instantly keys`);
    if (!clients.length) return;

    const limit = pLimit(CONCURRENCY);
    const startedAt = Date.now();

    const results = await Promise.allSettled(
        clients.map((client) => limit(async () => {
            const label = `${client.agencyId}/${client.clientSlug}`;
            const clientId = Number(client.clientId) || null;
            if (!clientId) {
                console.log(`[follow-up-worker] Missing client_id for ${label}, skipping`);
                return null;
            }
            console.log(`[follow-up-worker] Running for ${label} (client_id=${clientId})`);
            const summary = await runFollowUpsForClient({
                agencyId: client.agencyId,
                clientSlug: client.clientSlug,
                instantlyKey: client.instantlyKey,
                clientId,
                dryRun: DRY_RUN,
                batchSize: BATCH_SIZE,
                logger: (msg) => console.log(`[follow-up-worker][${label}]`, msg)
            });
            console.log(`[follow-up-worker] Summary for ${label}:`, summary);
            return summary;
        }))
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    console.log(`[follow-up-worker] Pass completed in ${Date.now() - startedAt}ms (${succeeded} ok, ${failed} failed)`);

    results
        .filter((r) => r.status === 'rejected')
        .forEach((r) => {
            console.error('[follow-up-worker] Client run failed:', r.reason?.message || r.reason);
        });
}

async function loop() {
    const modeLabel = DRY_RUN ? ' [DRY RUN]' : '';
    console.log(`[follow-up-worker] Started${modeLabel} — schedule: ${SCHEDULE_TIMES_RAW}, tz: ${TIMEZONE}, batch: ${BATCH_SIZE}, concurrency: ${CONCURRENCY}`);

    while (!shutdownRequested) {
        const waitMs = msUntilNextRun(new Date(), SCHEDULE_TIMES, TIMEZONE);
        const nextAt = new Date(Date.now() + waitMs).toISOString();
        console.log(`[follow-up-worker] Next run at ${nextAt} (waiting ${Math.round(waitMs / 1000)}s)`);

        // Sleep in chunks to allow clean shutdown
        const deadline = Date.now() + waitMs;
        while (!shutdownRequested && Date.now() < deadline) {
            await sleep(Math.min(10_000, deadline - Date.now()));
        }
        if (shutdownRequested) break;

        console.log('[follow-up-worker] Starting scheduled pass');
        try {
            await runPass();
        } catch (err) {
            console.error('[follow-up-worker] Pass failed:', err?.message || err);
        }
    }

    console.log('[follow-up-worker] Shutting down');
}

process.on('SIGINT', () => { shutdownRequested = true; });
process.on('SIGTERM', () => { shutdownRequested = true; });

loop().catch((err) => {
    console.error('[follow-up-worker] Fatal error:', err);
    process.exit(1);
});
