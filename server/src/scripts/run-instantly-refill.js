/**
 * Run the Instantly lead refill for one client by hand (e.g. a supervised first
 * run). Without --apply it syncs the campaign, then prints the plan and the
 * first candidates without verifying or adding anything. --apply runs the real
 * thing even if the client's toggle is off; the client's campaign, cooldown and
 * backlog days still apply.
 *
 * Usage:
 *   node src/scripts/run-instantly-refill.js <clientSlug> [agencyId] [--apply]
 * Slugs repeat across agencies; pass the agency id when more than one matches.
 */

import { pool } from '../config/db.js';
import { getRefillSettings, runInstantlyRefill } from '../services/instantlyRefill.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const [clientSlug, agencyId = null] = args.filter((a) => a !== '--apply');

if (!clientSlug) {
    console.error('Usage: node src/scripts/run-instantly-refill.js <clientSlug> [agencyId] [--apply]');
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

    const settings = await getRefillSettings(client.id);
    console.log('[refill] settings', settings);
    const result = await runInstantlyRefill({
        agencyId: client.agency_id,
        clientSqlId: client.id,
        clientSlug: client.slug,
        instantlyKey: client.instantly_key,
        triggerSource: 'manual',
        force: true,
        dryRun: !apply,
        logger: (m) => console.log(`[refill] ${m}`)
    });
    console.log('[refill] result', JSON.stringify(result, null, 2));
    if (!apply) console.log('[refill] dry run — pass --apply to re-verify and add.');
}

main()
    .catch((err) => {
        console.error('[refill] failed:', err?.message || err);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
