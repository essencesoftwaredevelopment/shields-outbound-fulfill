#!/usr/bin/env node
/**
 * Compare enrichment output for two jobs (PM2 vs Vercel shadow run).
 *
 * Usage:
 *   node scripts/shadow-enrichment-diff.mjs <pm2JobId> <vercelJobId> [agencyId]
 *
 * Prints contact counts and shopping-audit row counts side by side.
 */
import pg from 'pg';

const [pm2JobId, vercelJobId, agencyIdArg] = process.argv.slice(2);
if (!pm2JobId || !vercelJobId) {
    console.error('Usage: node scripts/shadow-enrichment-diff.mjs <pm2JobId> <vercelJobId> [agencyId]');
    process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function jobSnapshot(jobId, agencyId) {
    const job = await pool.query(
        `SELECT id, agency_id, status, cost, stages, options FROM jobs WHERE id = $1`,
        [jobId]
    );
    const row = job.rows[0];
    if (!row) throw new Error(`Job not found: ${jobId}`);
    if (agencyId && row.agency_id !== agencyId) {
        throw new Error(`Job ${jobId} agency mismatch`);
    }

    const contacts = await pool.query(
        `SELECT COUNT(*)::int AS n FROM contacts WHERE job_id = $1`,
        [jobId]
    );
    const signals = await pool.query(
        `SELECT COUNT(*)::int AS n FROM shopping_signal_emissions WHERE job_id = $1`,
        [jobId]
    ).catch(() => ({ rows: [{ n: null }] }));

    return {
        jobId,
        status: row.status,
        runner: row.options?.executionRunner || 'pm2',
        cost: row.cost,
        contacts: contacts.rows[0]?.n ?? 0,
        signals: signals.rows[0]?.n,
        stages: row.stages
    };
}

try {
    const pm2 = await jobSnapshot(pm2JobId, agencyIdArg);
    const vercel = await jobSnapshot(vercelJobId, agencyIdArg);
    console.log(JSON.stringify({ pm2, vercel, match: {
        contacts: pm2.contacts === vercel.contacts,
        signals: pm2.signals === vercel.signals
    } }, null, 2));
} finally {
    await pool.end();
}
