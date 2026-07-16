#!/usr/bin/env node
/**
 * Phase 2 — Batch test metrics for a shopping_audit job.
 *
 * Usage:
 *   node src/scripts/shopping-audit-batch-report.js --job-id JOB_ID
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import '../config/env.js';
import { pool } from '../config/db.js';
import { getBatchAuditMetrics } from '../services/shoppingAudit/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');
dotenv.config({ path: path.join(WORKSPACE_ROOT, '.env.local'), override: false });
dotenv.config({ path: path.join(WORKSPACE_ROOT, '.env'), override: false });

function parseArgs(argv) {
    const args = { jobId: '' };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--job-id') args.jobId = argv[++i];
    }
    return args;
}

async function main() {
    const { jobId } = parseArgs(process.argv.slice(2));
    if (!jobId) {
        console.error('Usage: node src/scripts/shopping-audit-batch-report.js --job-id JOB_ID');
        process.exit(1);
    }

    const jobResult = await pool.query(
        `SELECT id, options, stages, dedupe_stats FROM jobs WHERE id = $1`,
        [jobId]
    );
    const job = jobResult.rows[0];
    if (!job) {
        console.error(`Job ${jobId} not found`);
        process.exit(1);
    }

    const metrics = await getBatchAuditMetrics(jobId);
    const domainStats = await pool.query(
        `SELECT status, COUNT(*)::int AS count FROM job_domains WHERE job_id = $1 GROUP BY status`,
        [jobId]
    );

    const totalDomains = (job.dedupe_stats?.processable || job.dedupe_stats?.total || 0);
    const signalCount = Number(metrics.any_signal_count || 0);
    const priceMismatch = Number(metrics.price_mismatch_count || 0);
    const adTotal = Number(metrics.ad_observation_total || 0);
    const adMatched = Number(metrics.ad_found_matched || 0);
    const adClean = Number(metrics.ad_found_clean || 0);
    const headless = Number(metrics.headless_count || 0);
    // Legacy jobs predate the binary `matched` column — fall back to branch='clean'.
    const adFound = adMatched || adClean;

    const methodStats = await pool.query(
        `SELECT seller_match_method, COUNT(*)::int AS count
         FROM ad_observations
         WHERE job_id = $1 AND seller_match_method IS NOT NULL
         GROUP BY seller_match_method`,
        [jobId]
    );

    const report = {
        job_id: jobId,
        pipeline_mode: job.options?.pipelineMode || 'standard',
        total_domains: totalDomains,
        price_mismatch_rate: totalDomains ? (priceMismatch / totalDomains) : 0,
        any_signal_rate: totalDomains ? (signalCount / totalDomains) : 0,
        serper_ad_found_rate: adTotal ? (adFound / adTotal) : 0,
        headless_escalation_rate: adTotal ? (headless / adTotal) : 0,
        counts: {
            price_mismatch: priceMismatch,
            any_signal: signalCount,
            ad_observations: adTotal,
            ad_matched: adMatched,
            ad_clean: adClean,
            headless_rescues: headless
        },
        seller_match_methods: Object.fromEntries(
            methodStats.rows.map((r) => [r.seller_match_method, r.count])
        ),
        job_domains: Object.fromEntries(domainStats.rows.map((r) => [r.status, r.count])),
        stages: job.stages
    };

    console.log(JSON.stringify(report, null, 2));
    await pool.end();
}

main().catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
});
