/**
 * Run the Instantly lead cleanup for one client by hand (e.g. a supervised
 * first run). Without --apply it only prints what qualifies right now.
 * --apply runs the real thing (sync → reply backfill → per-lead delete) even if
 * the client's toggle is off; the client's day threshold still applies.
 *
 * Usage:
 *   DATABASE_URL=... node src/scripts/run-instantly-cleanup.js <clientSlug> [agencyId] [--apply]
 * Slugs repeat across agencies; pass the agency id when more than one matches.
 */

import { pool } from '../config/db.js';
import { getCleanupSettings, previewCleanup, runInstantlyCleanup } from '../services/instantlyCleanup.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const [clientSlug, agencyId = null] = args.filter((a) => a !== '--apply');

if (!clientSlug) {
    console.error('Usage: node src/scripts/run-instantly-cleanup.js <clientSlug> [agencyId] [--apply]');
    process.exit(1);
}

async function main() {
    const { rows } = await pool.query(
        `SELECT id, agency_id, slug, instantly_key FROM clients
         WHERE slug = $1 AND ($2::text IS NULL OR agency_id = $2)
           AND instantly_key IS NOT NULL AND BTRIM(instantly_key) <> ''`,
        [clientSlug, agencyId]
    );
    if (rows.length > 1) {
        throw new Error(`${rows.length} clients named ${clientSlug} have Instantly keys; pass the agency id: ${rows.map((r) => r.agency_id).join(', ')}`);
    }
    const client = rows[0];
    if (!client) throw new Error(`No client ${clientSlug}${agencyId ? ` in agency ${agencyId}` : ''} with an Instantly key`);

    const settings = await getCleanupSettings(client.id);
    const preview = await previewCleanup({ clientSqlId: client.id, instantlyKey: client.instantly_key, days: settings.days });
    console.log(`[cleanup] ${clientSlug}: enabled=${settings.enabled} days=${settings.days}`);
    console.log(`[cleanup] qualifies now: ${preview.total} across ${preview.campaigns} campaign(s)`, preview.byCategory);
    if (!apply) {
        console.log('[cleanup] dry run — pass --apply to sync, backfill and delete.');
        return;
    }

    const result = await runInstantlyCleanup({
        agencyId: client.agency_id,
        clientSqlId: client.id,
        clientSlug: client.slug,
        instantlyKey: client.instantly_key,
        triggerSource: 'manual',
        force: true,
        logger: (m) => console.log(`[cleanup] ${m}`)
    });
    console.log('[cleanup] done', result.summary);
}

main()
    .catch((err) => {
        console.error('[cleanup] failed:', err?.message || err);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
