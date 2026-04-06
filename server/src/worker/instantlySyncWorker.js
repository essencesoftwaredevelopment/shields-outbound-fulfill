import pLimit from 'p-limit';
import { listInstantlySyncClients, runInstantlySyncJob } from '../services/instantlyState.js';

const POLL_INTERVAL_MS = Math.max(parseInt(process.env.INSTANTLY_SYNC_INTERVAL_MS || '900000', 10) || 900000, 60000);
const CONCURRENCY = Math.max(parseInt(process.env.INSTANTLY_SYNC_CONCURRENCY || '2', 10) || 2, 1);

let shutdownRequested = false;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPass() {
    const clients = await listInstantlySyncClients();
    console.log(`[instantly-sync] Found ${clients.length} client(s) with Instantly keys`);
    if (!clients.length) return;

    const limit = pLimit(CONCURRENCY);
    const startedAt = Date.now();
    const results = await Promise.allSettled(
        clients.map((client) => limit(async () => {
            const label = `${client.agencyId}/${client.clientSlug}`;
            console.log(`[instantly-sync] Starting sync for ${label}`);
            const result = await runInstantlySyncJob({
                agencyId: client.agencyId,
                clientSlug: client.clientSlug,
                instantlyKey: client.instantlyKey,
                triggerSource: 'scheduled',
                logger: (message) => console.log(`[instantly-sync][${label}] ${message}`)
            });
            if (result.alreadyRunning) {
                console.log(`[instantly-sync] Skipped ${label}; sync run ${result.run?.id} already in progress`);
                return result.run;
            }
            console.log(`[instantly-sync] Finished sync for ${label}`, result.summary);
            return result.summary;
        }))
    );

    const succeeded = results.filter((result) => result.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    console.log(`[instantly-sync] Pass completed in ${Date.now() - startedAt}ms (${succeeded} succeeded, ${failed} failed)`);

    results
        .filter((result) => result.status === 'rejected')
        .forEach((result) => {
            console.error('[instantly-sync] Client sync failed:', result.reason?.message || result.reason);
        });
}

async function loop() {
    console.log(`[instantly-sync] Worker started (interval ${POLL_INTERVAL_MS}ms, concurrency ${CONCURRENCY})`);
    while (!shutdownRequested) {
        const startedAt = Date.now();
        try {
            await runPass();
        } catch (error) {
            console.error('[instantly-sync] Worker pass failed:', error?.message || error);
        }

        const remaining = POLL_INTERVAL_MS - (Date.now() - startedAt);
        if (shutdownRequested) break;
        if (remaining > 0) {
            await sleep(remaining);
        }
    }
    console.log('[instantly-sync] Worker shutting down');
}

process.on('SIGINT', () => {
    shutdownRequested = true;
});

process.on('SIGTERM', () => {
    shutdownRequested = true;
});

loop().catch((error) => {
    console.error('[instantly-sync] Fatal worker error:', error);
    process.exit(1);
});
