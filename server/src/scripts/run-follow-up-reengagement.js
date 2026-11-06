/**
 * One deliberate follow-up agent send to leads who finished the static sequence.
 * The scheduled worker never touches these leads, so this only runs by hand.
 * Lists who would get an email by default; pass --send to really send.
 * Once a lead gets an agent email, the scheduled worker continues their sequence
 * up to the client's touch limit.
 *
 *   node src/scripts/run-follow-up-reengagement.js --client=2 --limit=25
 *   node src/scripts/run-follow-up-reengagement.js --client=2 --limit=25 --send
 */
import { pool } from '../config/db.js';
import { getEligibleProspects, recheckProspect } from '../services/followUpSender.js';
import { startFollowUpGeneration, failGenerationRun } from '../services/warmFollowUpGeneration/index.js';
import { isWarmFollowUpWorkflowConfigured, triggerWarmFollowUpWorkflow } from '../services/warmFollowUpGeneration/trigger.js';

const args = process.argv.slice(2);
const argValue = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
const clientId = Number(argValue('client'));
const limit = Number(argValue('limit'));
const send = args.includes('--send');

if (!Number.isInteger(clientId) || !Number.isInteger(limit) || limit < 1) {
    console.error('Usage: run-follow-up-reengagement.js --client=<id> --limit=<n> [--send]');
    process.exit(2);
}

const { rows: [client] } = await pool.query(
    `SELECT id, name, agency_id, follow_up_ai_enabled, follow_up_agent_enabled,
            follow_up_agent_max_touches, follow_up_agent_min_gap_days
     FROM clients WHERE id = $1`,
    [clientId]
);
if (!client) throw new Error(`Client ${clientId} not found`);
if (client.follow_up_agent_enabled !== true || client.follow_up_ai_enabled !== true) {
    throw new Error(`${client.name}: the follow-up agent and live AI must both be on.`);
}
if (send && !isWarmFollowUpWorkflowConfigured()) {
    throw new Error('Warm-follow-up workflow is not configured (WORKFLOW_TRIGGER_SECRET).');
}

const sentForDate = new Date().toISOString().slice(0, 10);
const prospects = await getEligibleProspects(pool, clientId, sentForDate, {
    maxTouches: client.follow_up_agent_max_touches,
    minGapDays: client.follow_up_agent_min_gap_days,
    finishedOnly: true
});
const reachable = prospects.filter((prospect) => prospect.reply_to_uuid && prospect.eaccount);
const batch = reachable.slice(0, limit);

console.log(`${client.name}: ${prospects.length} finished leads eligible, ${reachable.length} with thread details, ${batch.length} in this batch.`);
if (!send) {
    for (const prospect of batch) console.log(`  ${prospect.email} (campaign ${prospect.campaign_id})`);
    console.log('Nothing sent. Add --send to send.');
    await pool.end();
    process.exit(0);
}

const summary = { queued: 0, skipped: 0, failed: 0 };
for (const prospect of batch) {
    const recheck = await recheckProspect(pool, prospect.contact_id, prospect.campaign_id, sentForDate);
    if (recheck.blocked) {
        summary.skipped += 1;
        continue;
    }
    let runId = null;
    try {
        const run = await startFollowUpGeneration({
            agencyId: client.agency_id,
            clientId,
            contactId: prospect.contact_id,
            campaignId: prospect.campaign_id,
            scriptId: null,
            mode: 'send',
            sentForDate
        });
        runId = run.id;
        await triggerWarmFollowUpWorkflow({ runId, agencyId: client.agency_id });
        summary.queued += 1;
        console.log(`  queued run=${runId} ${prospect.email}`);
    } catch (err) {
        summary.failed += 1;
        console.error(`  failed ${prospect.email}: ${err.message}`);
        if (runId) await failGenerationRun({ runId, agencyId: client.agency_id, errorInfo: { message: err.message } }).catch(() => {});
    }
}
console.log('Done:', summary);
await pool.end();
process.exit(0);
