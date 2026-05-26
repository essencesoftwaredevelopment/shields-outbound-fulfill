import { pool } from '../config/db.js';
import { stopAllActiveInstantlySyncRuns } from '../services/instantlyState.js';

async function main() {
    const reason = (process.env.INSTANTLY_SYNC_STOP_REASON || 'Sync stopped by operator').trim();
    const stopped = await stopAllActiveInstantlySyncRuns({ reason });
    if (!stopped.length) {
        console.log('[instantly-sync] No active sync runs to stop.');
        return;
    }
    console.log(`[instantly-sync] Stopped ${stopped.length} run(s):`);
    for (const run of stopped) {
        console.log(`  - run ${run.id} (client ${run.clientId}) → cancelled`);
    }
}

main()
    .catch((error) => {
        console.error('[instantly-sync] Failed to stop active sync runs:', error?.message || error);
        process.exit(1);
    })
    .finally(async () => {
        await pool.end().catch(() => {});
    });
