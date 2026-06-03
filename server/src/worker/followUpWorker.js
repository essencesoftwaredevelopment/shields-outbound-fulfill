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

// ─── Config ──────────────────────────────────────────────────────────────────

const SCHEDULE_TIMES_RAW = process.env.FOLLOWUP_SCHEDULE_TIMES || '09:00,14:00';
const TIMEZONE = process.env.FOLLOWUP_TIMEZONE || 'UTC';
const BATCH_SIZE = Math.max(parseInt(process.env.FOLLOWUP_BATCH_SIZE || '50', 10) || 50, 1);
const CONCURRENCY = Math.max(parseInt(process.env.FOLLOWUP_CONCURRENCY || '2', 10) || 2, 1);
const DRY_RUN = process.env.FOLLOWUP_DRY_RUN === 'true';

/**
 * Parse schedule times, e.g. "09:00,14:00" → [{ hour: 9, minute: 0 }, ...]
 */
function parseScheduleTimes(raw) {
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
            const [h, m] = s.split(':').map(Number);
            if (!Number.isFinite(h) || !Number.isFinite(m)) {
                throw new Error(`Invalid FOLLOWUP_SCHEDULE_TIMES entry: "${s}"`);
            }
            return { hour: h, minute: m };
        });
}

const SCHEDULE_TIMES = parseScheduleTimes(SCHEDULE_TIMES_RAW);

/**
 * Return milliseconds until the next scheduled run, evaluating all configured
 * times in the given IANA timezone. Picks the earliest future slot.
 */
function msUntilNextRun() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    });

    const parts = Object.fromEntries(
        formatter.formatToParts(now).map(({ type, value }) => [type, value])
    );

    const tzYear = parseInt(parts.year, 10);
    const tzMonth = parseInt(parts.month, 10) - 1;
    const tzDay = parseInt(parts.day, 10);

    const candidates = [];

    for (const { hour, minute } of SCHEDULE_TIMES) {
        // Build candidate Date objects for today and tomorrow in TZ
        for (const dayOffset of [0, 1]) {
            const candidateTzDate = new Date(
                `${String(tzYear).padStart(4, '0')}-` +
                `${String(tzMonth + 1 + (dayOffset === 1 && tzDay === new Date(tzYear, tzMonth + 1, 0).getDate() ? 1 : 0)).padStart(2, '0')}-` +
                `${String(tzDay + dayOffset).padStart(2, '0')}T` +
                `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`
            );

            // Convert TZ-local string to UTC by applying the TZ offset
            const utcMs = candidateTzDate.getTime() - getTimezoneOffsetMs(now, TIMEZONE);
            candidates.push(utcMs);
        }
    }

    const futureMs = candidates.filter((ms) => ms > now.getTime());
    if (!futureMs.length) {
        return 60 * 60 * 1000; // fallback 1h
    }
    return Math.min(...futureMs) - now.getTime();
}

/**
 * Compute the UTC offset in milliseconds for the given timezone at the given Date.
 * Uses Intl to parse the local hour and compares with UTC hour.
 */
function getTimezoneOffsetMs(date, tz) {
    const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC', hour12: false });
    const tzStr = date.toLocaleString('en-US', { timeZone: tz, hour12: false });
    const utcDate = new Date(utcStr);
    const tzDate = new Date(tzStr);
    return utcDate.getTime() - tzDate.getTime();
}

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
        const waitMs = msUntilNextRun();
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
