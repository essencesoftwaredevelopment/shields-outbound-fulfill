/**
 * Pull recent Fathom recordings for an agency and analyse the ones that match a
 * prospect (same as what happens after the Fathom key is saved in the vault).
 * Without --apply it only lists the recordings and which already exist.
 *
 * Usage:
 *   node src/scripts/fathom-backfill.js <agencyId> [--days=90] [--apply] [--inline]
 * --inline runs the analysis in this process instead of the Vercel workflow.
 */
import { pool } from '../config/db.js';
import { getAgencySettings } from '../services/db/agencySettings.js';
import { listFathomMeetings } from '../services/fathom.js';
import { backfillFathomRecordings, externalEmails } from '../services/callAnalysis/index.js';

const args = process.argv.slice(2);
const agencyId = args.find((arg) => !arg.startsWith('--'));
const days = Number((args.find((arg) => arg.startsWith('--days=')) || '--days=90').split('=')[1]) || 90;
const apply = args.includes('--apply');
if (args.includes('--inline')) process.env.CALL_ANALYSIS_WORKFLOW_DISABLED = 'true';

if (!agencyId) {
    console.error('Usage: node src/scripts/fathom-backfill.js <agencyId> [--days=90] [--apply] [--inline]');
    process.exit(1);
}

try {
    if (!apply) {
        const settings = await getAgencySettings(agencyId);
        const apiKey = String(settings?.fathom_key || '').trim();
        if (!apiKey) throw new Error('No Fathom API key saved for this agency.');
        const createdAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const meetings = await listFathomMeetings({ apiKey, createdAfter });
        const { rows } = await pool.query(
            `SELECT external_id, status FROM call_recordings WHERE agency_id = $1 AND provider = 'fathom'`,
            [agencyId]
        );
        const known = new Map(rows.map((row) => [row.external_id, row.status]));
        for (const meeting of meetings) {
            console.log([
                meeting.recording_id,
                (meeting.recording_start_time || '').slice(0, 10),
                meeting.meeting_title || meeting.title,
                externalEmails(meeting.calendar_invitees).join(' ') || '(no external attendees)',
                known.get(String(meeting.recording_id)) || 'new'
            ].join(' | '));
        }
        console.log(`\n${meetings.length} recordings in the last ${days} days. Re-run with --apply to analyse.`);
    } else {
        const summary = await backfillFathomRecordings({ agencyId, days });
        console.log(summary);
    }
} catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
