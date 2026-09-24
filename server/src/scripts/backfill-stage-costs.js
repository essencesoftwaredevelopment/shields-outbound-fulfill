/**
 * Backfill per-stage costs (job_stage_costs) for jobs that finished without them.
 *
 * Why: Vercel-run founders / emailDiscovery / verification batches passed the
 * whole pricing map instead of their stage's rates, so every lead cost $0 and
 * nothing reached the ledger (fixed in foundersBatch/emailsBatch/verificationBatch).
 * PM2-run jobs kept their costs in jobs.stages.<stage>.summary.cost only, which
 * the Pipeline cards (ledger via get_job_stage_counts) never read.
 *
 * Per stage, in order of trust:
 *   1. already in the ledger          → left alone (never double-counts)
 *   2. jobs.stages.<stage>.summary.cost → copied as-is (exact, PM2 jobs)
 *   3. rebuilt from counts × the agency's pricing, mirroring the services:
 *        emailDiscovery  found emails × request_cost          (exact)
 *        verification    checked emails × request_cost        (exact)
 *        founders        processed × serper_request_cost      (exact)
 *                        + processed × OpenAI estimate        (tokens were never stored)
 *   Stages the job skipped (CSV imports) cost nothing and are not written.
 *
 * Dry run unless --apply. Applied backfills are noted in jobs.options.costBackfill.
 *
 * Usage:
 *   DATABASE_URL=... node src/scripts/backfill-stage-costs.js <jobId> <agencyId> [--apply]
 */

import { pool } from '../config/db.js';
import { loadPricing, extractStageCostAmount } from '../utils/pricing.js';
import { addJobStageCost, getJobStageCosts } from '../services/db/jobStageCosts.js';

/**
 * Average OpenAI spend per founder-search domain, from this agency's PM2 jobs
 * that recorded real token costs (17 jobs, 91,032 domains, May–Jun 2026:
 * $0.001141/domain all-in, minus the $0.001 Serper call).
 */
const FOUNDER_OPENAI_PER_DOMAIN_ESTIMATE = 0.000141;

const [jobId, agencyId, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');

if (!jobId || !agencyId) {
    console.error('Usage: node src/scripts/backfill-stage-costs.js <jobId> <agencyId> [--apply]');
    process.exit(1);
}

const round6 = (n) => Number(n.toFixed(6));

async function main() {
    const { rows: [job] } = await pool.query(
        `SELECT id, status, options, stages, cost FROM jobs WHERE id = $1 AND agency_id = $2`,
        [jobId, agencyId]
    );
    if (!job) throw new Error(`Job ${jobId} not found for agency ${agencyId}`);
    if (job.status !== 'completed') {
        throw new Error(`Job ${jobId} is ${job.status}; only completed jobs are backfilled (a live run still writes costs).`);
    }

    const options = job.options || {};
    const stages = job.stages || {};
    const { rows: [{ counts }] } = await pool.query(`SELECT get_job_stage_counts($1) AS counts`, [jobId]);
    const pricing = (await loadPricing(agencyId)).stages;
    const ledger = await getJobStageCosts(jobId);

    const founders = Number(counts?.founders?.processed) || 0;
    const emailsFound = Number(counts?.emailDiscovery?.found) || 0;
    const verified = Number(counts?.verification?.verified) || 0;

    const rebuilt = {
        founders: options.skipFounderFinder ? null : {
            amount: founders * (Number(pricing.founders?.serper_request_cost) || 0)
                + founders * FOUNDER_OPENAI_PER_DOMAIN_ESTIMATE,
            basis: `${founders} domains × ($${pricing.founders?.serper_request_cost} Serper + ~$${FOUNDER_OPENAI_PER_DOMAIN_ESTIMATE} OpenAI est.)`
        },
        emailDiscovery: options.skipEmailFinder ? null : {
            amount: emailsFound * (Number(pricing.emailDiscovery?.request_cost) || 0),
            basis: `${emailsFound} found × $${pricing.emailDiscovery?.request_cost}`
        },
        verification: options.skipVerification ? null : {
            amount: verified * (Number(pricing.verification?.request_cost) || 0),
            basis: `${verified} checked × $${pricing.verification?.request_cost}`
        }
    };

    const plan = [];
    for (const [stage, estimate] of Object.entries(rebuilt)) {
        if ((ledger[stage] || 0) > 0) {
            plan.push({ stage, action: 'keep', amount: ledger[stage], basis: 'already in ledger' });
            continue;
        }
        const recorded = extractStageCostAmount(stages[stage]);
        if (recorded > 0) {
            plan.push({ stage, action: 'write', amount: round6(recorded), basis: 'jobs.stages summary (recorded at run time)' });
        } else if (!estimate) {
            plan.push({ stage, action: 'skip', amount: 0, basis: 'stage skipped for this job' });
        } else if (estimate.amount > 0) {
            plan.push({ stage, action: 'write', amount: round6(estimate.amount), basis: estimate.basis });
        } else {
            plan.push({ stage, action: 'skip', amount: 0, basis: 'no billable work' });
        }
    }

    console.log(`[backfill-costs] job=${jobId} status=${job.status} jobs.cost=${Number(job.cost) || 0}${apply ? '' : ' (dry run)'}`);
    console.table(plan.map((p) => ({ ...p, amount: `$${p.amount.toFixed(4)}` })));
    const toWrite = plan.filter((p) => p.action === 'write');
    const added = toWrite.reduce((sum, p) => sum + p.amount, 0);
    console.log(`[backfill-costs] would add $${added.toFixed(4)} → jobs.cost $${((Number(job.cost) || 0) + added).toFixed(4)}`);
    if (!apply || !toWrite.length) return;

    for (const p of toWrite) {
        await addJobStageCost(jobId, agencyId, p.stage, p.amount);
    }
    await pool.query(
        `UPDATE jobs SET options = COALESCE(options, '{}'::jsonb) || jsonb_build_object('costBackfill', $3::jsonb)
         WHERE id = $1 AND agency_id = $2`,
        [jobId, agencyId, JSON.stringify({
            at: new Date().toISOString(),
            stages: Object.fromEntries(toWrite.map((p) => [p.stage, { amount: p.amount, basis: p.basis }]))
        })]
    );
    console.log(`[backfill-costs] applied ${toWrite.length} stage cost(s).`);
}

main()
    .catch((err) => {
        console.error('[backfill-costs] failed:', err?.message || err);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
