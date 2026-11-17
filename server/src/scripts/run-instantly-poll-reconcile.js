/**
 * Run the Instantly reply poll for one client now (seed or live, whichever
 * is due). The scheduled sweep ignores clients that already have a webhook;
 * pass --force to run anyway.
 *
 * Usage:
 *   node src/scripts/run-instantly-poll-reconcile.js <clientSlug> [agencyId] [--force]
 */

import { pool } from '../config/db.js';
import { runInstantlyPollReconcile } from '../services/instantlyPollReconcile.js';

const args = process.argv.slice(2);
const force = args.includes('--force');
const [clientSlug, agencyId = null] = args.filter((arg) => arg !== '--force');

if (!clientSlug) {
    console.error('Usage: node src/scripts/run-instantly-poll-reconcile.js <clientSlug> [agencyId] [--force]');
    process.exit(1);
}

async function main() {
    const { rows } = await pool.query(
        `SELECT id, agency_id, slug, instantly_key, instantly_webhook_id, instantly_poll_reconcile
         FROM clients
         WHERE slug = $1 AND ($2::text IS NULL OR agency_id = $2)
           AND instantly_key IS NOT NULL AND BTRIM(instantly_key) <> ''`,
        [clientSlug, agencyId]
    );
    if (rows.length > 1) {
        throw new Error(`${rows.length} clients named ${clientSlug} have Instantly keys; pass the agency id: ${rows.map((row) => row.agency_id).join(', ')}`);
    }
    const client = rows[0];
    if (!client) throw new Error(`No client ${clientSlug}${agencyId ? ` in agency ${agencyId}` : ''} with an Instantly key`);
    if (!client.instantly_poll_reconcile) {
        console.log('[instantly-poll] toggle is off; running this pass anyway');
    }
    if (client.instantly_webhook_id && !force) {
        console.log('[instantly-poll] webhook is linked; pass --force to poll anyway');
        return;
    }

    const summary = await runInstantlyPollReconcile({
        agencyId: client.agency_id,
        clientId: client.id,
        clientSlug: client.slug,
        instantlyKey: client.instantly_key,
        force,
        logger: (message) => console.log(`[instantly-poll] ${message}`)
    });
    console.log('[instantly-poll] result', JSON.stringify(summary, null, 2));
}

main()
    .catch((error) => {
        console.error('[instantly-poll] failed:', error?.message || error);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
