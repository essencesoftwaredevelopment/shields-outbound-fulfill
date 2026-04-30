/**
 * run-follow-ups-once.js
 *
 * One-off follow-up sender script. Supports --dry-run and optional client
 * filtering via environment variables.
 *
 * Usage:
 *   pnpm followups:send-once
 *   FOLLOWUP_DRY_RUN=true pnpm followups:send-once
 *   INSTANTLY_SYNC_AGENCY_ID=myagency FOLLOWUP_DRY_RUN=true pnpm followups:send-once
 *   INSTANTLY_SYNC_CLIENT_ID=myclient pnpm followups:send-once
 */

import { runFollowUpsOnce } from '../services/followUpSender.js';

const dryRun = process.env.FOLLOWUP_DRY_RUN === 'true' || process.argv.includes('--dry-run');
const filterAgencyId = (process.env.INSTANTLY_SYNC_AGENCY_ID || '').trim();
const filterClientSlug = (process.env.INSTANTLY_SYNC_CLIENT_ID || '').trim();

if (dryRun) {
    console.log('[follow-ups-once] DRY RUN mode — no emails will be sent');
}

runFollowUpsOnce({
    dryRun,
    filterAgencyId,
    filterClientSlug,
    logger: console.log
})
    .then(() => {
        process.exit(0);
    })
    .catch((err) => {
        console.error('[follow-ups-once] Fatal error:', err);
        process.exit(1);
    });
