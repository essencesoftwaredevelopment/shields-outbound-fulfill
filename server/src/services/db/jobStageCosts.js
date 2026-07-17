import { pool } from '../config/db.js';

/**
 * Atomic stage cost increment — one narrow row per (job_id, stage).
 * Prefer calling once per batch (not per progress tick) so concurrent children
 * only briefly contend on that stage row, never on jobs.stages JSON.
 *
 * @param {string} jobId
 * @param {string} agencyId
 * @param {string} stage
 * @param {number} amount
 */
export async function addJobStageCost(jobId, agencyId, stage, amount) {
    const delta = Number(amount);
    if (!jobId || !agencyId || !stage || !(delta > 0) || !Number.isFinite(delta)) {
        return;
    }

    await pool.query(
        `INSERT INTO job_stage_costs (job_id, agency_id, stage, amount)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (job_id, stage) DO UPDATE SET
            amount = job_stage_costs.amount + EXCLUDED.amount,
            updated_at = NOW()`,
        [jobId, agencyId, stage, delta]
    );

    await pool.query(
        `UPDATE jobs SET cost = COALESCE(cost, 0) + $3, updated_at = NOW()
         WHERE id = $1 AND agency_id = $2`,
        [jobId, agencyId, delta]
    );
}

/**
 * @param {string} jobId
 * @returns {Promise<Record<string, number>>}
 */
export async function getJobStageCosts(jobId) {
    const { rows } = await pool.query(
        `SELECT stage, amount::float8 AS amount FROM job_stage_costs WHERE job_id = $1`,
        [jobId]
    );
    const out = {};
    for (const row of rows) {
        out[row.stage] = Number(row.amount) || 0;
    }
    return out;
}
