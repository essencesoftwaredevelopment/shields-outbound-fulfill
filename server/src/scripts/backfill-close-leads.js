/**
 * Push every contact that already has a phone number into Close (one-off
 * backfill for leads that replied before features.closeLeads was on). Uses the
 * same sync as the reply path, so the agency's flag, client scope and the
 * per-contact claim all apply, and contacts already in Close are skipped. The
 * latest interested reply (campaign + message) becomes the lead's note.
 * Without --apply it only lists what would be pushed.
 *
 * Usage:
 *   node src/scripts/backfill-close-leads.js [agencyId] [--apply]
 */

import { pool } from '../config/db.js';
import { getAgencySettings, closeLeadsEnabled } from '../services/db/agencySettings.js';
import { syncCloseLeadForContact } from '../services/closeLeadSync.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const [agencyId = null] = args.filter((a) => a !== '--apply');

async function main() {
    const { rows } = await pool.query(
        `SELECT c.id, c.agency_id, c.client_id, c.email, c.phone,
                d.campaign_name, d.previous_lead_message
         FROM contacts c
         LEFT JOIN LATERAL (
             SELECT ic.name AS campaign_name, ad.previous_lead_message
             FROM interested_autoresponder_drafts ad
             JOIN instantly_campaigns ic ON ic.id = ad.campaign_id
             WHERE ad.contact_id = c.id
             ORDER BY ad.created_at DESC
             LIMIT 1
         ) d ON TRUE
         WHERE c.phone IS NOT NULL AND BTRIM(c.phone) <> ''
           AND c.close_lead_id IS NULL
           AND ($1::text IS NULL OR c.agency_id = $1)
         ORDER BY c.id`,
        [agencyId]
    );

    const settingsByAgency = new Map();
    const tally = {};
    for (const row of rows) {
        if (!settingsByAgency.has(row.agency_id)) {
            settingsByAgency.set(row.agency_id, await getAgencySettings(row.agency_id));
        }
        if (!closeLeadsEnabled(settingsByAgency.get(row.agency_id), row.client_id)) {
            tally.not_enabled = (tally.not_enabled || 0) + 1;
            continue;
        }
        if (!apply) {
            console.log(`[close-backfill] would push contact=${row.id} ${row.email} ${row.phone} (${row.campaign_name || 'no reply found'})`);
            tally.would_push = (tally.would_push || 0) + 1;
            continue;
        }
        const result = await syncCloseLeadForContact({
            agencyId: row.agency_id,
            contactId: row.id,
            clientId: row.client_id,
            campaignName: row.campaign_name,
            replyText: row.previous_lead_message
        });
        tally[result.status] = (tally[result.status] || 0) + 1;
        console.log(`[close-backfill] contact=${row.id} ${row.email} → ${result.status}${result.url ? ` ${result.url}` : ''}${result.reason ? ` (${result.reason})` : ''}`);
    }
    console.log(`[close-backfill] ${rows.length} contact(s) with a phone not yet in Close${apply ? '' : ' (dry run — pass --apply)'}`, tally);
}

main()
    .catch((error) => {
        console.error('[close-backfill] failed:', error);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
