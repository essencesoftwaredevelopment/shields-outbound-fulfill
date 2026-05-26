import os from 'os';
import { pool } from '../config/db.js';

function nowIso() {
    return new Date().toISOString();
}

function normalizeQueueStatus(status) {
    const allowed = new Set(['queued', 'running', 'paused', 'completed', 'cancelled', 'failed']);
    return allowed.has(status) ? status : 'queued';
}

export async function enqueuePipelineJob({ jobId, uid, clientId, payload = {} }) {
    if (!jobId || !uid || !clientId) {
        throw new Error('enqueuePipelineJob requires jobId, uid, and clientId');
    }

    const existing = await pool.query(`SELECT attempts FROM job_queue WHERE job_id = $1`, [jobId]);
    const attempts = Number(existing.rows[0]?.attempts || 0);

    await pool.query(
        `INSERT INTO job_queue (job_id, agency_id, client_slug, status, control, payload, attempts, enqueued_at, updated_at)
         VALUES ($1, $2, $3, 'queued', '{"paused":false,"cancelled":false}'::jsonb, $4::jsonb, $5, NOW(), NOW())
         ON CONFLICT (job_id) DO UPDATE SET
            status = 'queued',
            control = '{"paused":false,"cancelled":false}'::jsonb,
            payload = EXCLUDED.payload,
            runner_pid = NULL,
            runner_started_at = NULL,
            updated_at = NOW()`,
        [jobId, uid, clientId, JSON.stringify(payload), attempts]
    );
}

export async function getQueueJob(jobId) {
    if (!jobId) return null;
    const result = await pool.query(`SELECT * FROM job_queue WHERE job_id = $1`, [jobId]);
    const row = result.rows[0];
    if (!row) return null;
    return {
        id: row.job_id,
        jobId: row.job_id,
        uid: row.agency_id,
        clientId: row.client_slug,
        status: row.status,
        control: row.control,
        payload: row.payload,
        attempts: row.attempts
    };
}

export async function claimNextQueuedJob(workerId = `${os.hostname()}-${process.pid}`) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `SELECT job_id, agency_id, client_slug, control, payload, attempts
             FROM job_queue
             WHERE status = 'queued'
             ORDER BY enqueued_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1`
        );
        const row = result.rows[0];
        if (!row) {
            await client.query('COMMIT');
            return null;
        }
        if (row.control?.cancelled) {
            await client.query(
                `UPDATE job_queue SET status = 'cancelled', updated_at = NOW() WHERE job_id = $1`,
                [row.job_id]
            );
            await client.query('COMMIT');
            return null;
        }
        if (row.control?.paused) {
            await client.query(
                `UPDATE job_queue SET status = 'paused', updated_at = NOW() WHERE job_id = $1`,
                [row.job_id]
            );
            await client.query('COMMIT');
            return null;
        }

        await client.query(
            `UPDATE job_queue SET
                status = 'running',
                claimed_by = $2,
                claimed_at = NOW(),
                attempts = attempts + 1,
                updated_at = NOW()
             WHERE job_id = $1`,
            [row.job_id, workerId]
        );
        await client.query(
            `UPDATE jobs SET status = 'running', updated_at = NOW() WHERE id = $1`,
            [row.job_id]
        );
        await client.query('COMMIT');
        return {
            id: row.job_id,
            jobId: row.job_id,
            uid: row.agency_id,
            clientId: row.client_slug,
            status: 'running',
            control: row.control,
            payload: row.payload,
            workerId
        };
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function updateQueueControl(jobId, controlPatch = {}) {
    if (!jobId) return;
    await pool.query(
        `UPDATE job_queue SET
            control = control || $2::jsonb,
            updated_at = NOW()
         WHERE job_id = $1`,
        [jobId, JSON.stringify(controlPatch)]
    );
}

export async function setQueueStatus(jobId, status, extra = {}) {
    if (!jobId) return;
    const normalizedStatus = normalizeQueueStatus(status);
    const completed = ['completed', 'cancelled', 'failed'].includes(normalizedStatus);
    await pool.query(
        `UPDATE job_queue SET
            status = $2,
            error = COALESCE($3, error),
            updated_at = NOW(),
            completed_at = CASE WHEN $4 THEN NOW() ELSE completed_at END
         WHERE job_id = $1`,
        [jobId, normalizedStatus, extra.error ?? null, completed]
    );
}

export async function deleteQueueJob(jobId) {
    if (!jobId) return;
    await pool.query(`DELETE FROM job_queue WHERE job_id = $1`, [jobId]);
}

export async function setRunnerPid(jobId, pid, claimedBy = null) {
    if (!jobId || !pid) return;
    await pool.query(
        `UPDATE job_queue SET
            runner_pid = $2,
            runner_started_at = NOW(),
            claimed_by = COALESCE($3, claimed_by),
            updated_at = NOW()
         WHERE job_id = $1`,
        [jobId, pid, claimedBy]
    );
}

export async function clearRunnerPid(jobId) {
    if (!jobId) return;
    await pool.query(
        `UPDATE job_queue SET
            runner_pid = NULL,
            runner_started_at = NULL,
            updated_at = NOW()
         WHERE job_id = $1`,
        [jobId]
    );
}

export async function getRunnerRecord(jobId) {
    if (!jobId) return null;
    const result = await pool.query(
        `SELECT job_id, runner_pid, runner_started_at, status, control, claimed_by
         FROM job_queue WHERE job_id = $1`,
        [jobId]
    );
    return result.rows[0] || null;
}
