import { pool } from '../../config/db.js';
import { enrichmentQueueFromJoinSql } from './jobs.js';

/**
 * Queues + persistence for the Enrow fallback (see migrations/0062_enrow_fallback.sql).
 * Scoped to the job's founder cohort exactly like getEmailFindQueue/getVerifyQueue.
 */

const COHORT_SQL = `
    AND COALESCE(jd.raw_row->'_enrichment'->>'inFounderCohort', 'true') = 'true'
    AND COALESCE(jd.raw_row->'_enrichment'->>'founderExcluded', 'false') <> 'true'
    AND COALESCE(jd.raw_row->'_enrichment'->>'inEmailCohort', 'true') = 'true'
    AND jd.status <> 'skipped'`;

/**
 * Build the shared WHERE-clause params: an Enrow attempt only counts for THIS
 * run when reprocessing (`include`), mirroring the other stage queues.
 */
function attemptConstraint(column, params, { reprocessInclude, jobStartedAt }) {
    if (reprocessInclude && jobStartedAt) {
        params.push(jobStartedAt);
        return `AND (c.${column} IS NULL OR c.${column} < $${params.length}::timestamptz)`;
    }
    return `AND c.${column} IS NULL`;
}

function completedThisRun(column, params, { reprocessInclude, jobStartedAt }) {
    if (reprocessInclude && jobStartedAt) {
        params.push(jobStartedAt);
        return `AND c.${column} >= $${params.length}::timestamptz`;
    }
    return `AND c.${column} IS NOT NULL`;
}

function domainsClause(params, domains) {
    if (!Array.isArray(domains)) return null;
    params.push(domains);
    return params.length;
}

/**
 * Founders TryKitt already attempted (email_find_completed_at stamped) and came
 * back without an email, not yet sent to Enrow.
 *
 * @returns {Promise<Array<{ contact_id: string, domain: string, founder_name: string }>>}
 */
export async function getEnrowFindQueue(agencyId, clientId, jobId, {
    reprocessInclude = false,
    jobStartedAt = null,
    domains = null,
    limit = 5000
} = {}) {
    if (Array.isArray(domains) && !domains.length) return [];
    const params = [agencyId, clientId, jobId, limit];
    const opts = { reprocessInclude, jobStartedAt };
    const attempted = attemptConstraint('enrow_find_attempted_at', params, opts);
    const tried = completedThisRun('email_find_completed_at', params, opts);
    const domainsIdx = domainsClause(params, domains);
    const result = await pool.query(
        `SELECT DISTINCT ON (c.id)
                c.id::text AS contact_id,
                co.domain_normalized AS domain,
                c.full_name AS founder_name
         ${enrichmentQueueFromJoinSql(domainsIdx)}
         WHERE c.agency_id = $1 AND c.client_id = $2
           AND c.role_type = 'founder'
           AND (c.email IS NULL OR BTRIM(c.email) = '')
           AND c.full_name IS NOT NULL AND BTRIM(c.full_name) <> ''
           AND LOWER(BTRIM(c.full_name)) <> 'not found'
           ${tried}
           ${attempted}
           ${COHORT_SQL}
         ORDER BY c.id ASC
         LIMIT $4`,
        params
    );
    return result.rows;
}

/**
 * Emails TryKitt verified as risky/unknown (catch-all) that Enrow has not
 * re-checked yet. Enrow's own finds are already 'valid' and never re-queued.
 *
 * @returns {Promise<Array<{ contact_id: string, domain: string, email: string }>>}
 */
export async function getEnrowVerifyQueue(agencyId, clientId, jobId, {
    reprocessInclude = false,
    jobStartedAt = null,
    domains = null,
    limit = 5000
} = {}) {
    if (Array.isArray(domains) && !domains.length) return [];
    const params = [agencyId, clientId, jobId, limit];
    const opts = { reprocessInclude, jobStartedAt };
    const attempted = attemptConstraint('enrow_verify_attempted_at', params, opts);
    const verified = completedThisRun('email_verify_completed_at', params, opts);
    const domainsIdx = domainsClause(params, domains);
    const result = await pool.query(
        `SELECT DISTINCT ON (c.id)
                c.id::text AS contact_id,
                co.domain_normalized AS domain,
                c.email
         ${enrichmentQueueFromJoinSql(domainsIdx)}
         WHERE c.agency_id = $1 AND c.client_id = $2
           AND c.role_type = 'founder'
           AND c.email IS NOT NULL AND BTRIM(c.email) <> ''
           AND LOWER(TRIM(COALESCE(c.email_status, ''))) IN ('risky', 'unknown')
           AND COALESCE(c.email_verify_source, '') <> 'enrow'
           ${verified}
           ${attempted}
           ${COHORT_SQL}
         ORDER BY c.id ASC
         LIMIT $4`,
        params
    );
    return result.rows;
}

/** In-flight request for this job batch + kind, if a previous attempt submitted one. */
export async function getInflightEnrowRequest(jobId, batchKey, kind) {
    const result = await pool.query(
        `SELECT * FROM enrow_requests
         WHERE job_id = $1 AND batch_key = $2 AND kind = $3 AND status = 'ongoing'
         LIMIT 1`,
        [jobId, String(batchKey), kind]
    );
    return result.rows[0] || null;
}

export async function getEnrowRequest(id) {
    const result = await pool.query(`SELECT * FROM enrow_requests WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

export async function insertEnrowRequest({ id, agencyId, clientId, jobId, batchKey, kind, items, creditsInitial }) {
    await pool.query(
        `INSERT INTO enrow_requests (id, agency_id, client_id, job_id, batch_key, kind, items, requested, credits_initial)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [id, agencyId, clientId, jobId, String(batchKey), kind, JSON.stringify(items), items.length, creditsInitial]
    );
}

export async function closeEnrowRequest(id, { status, found = null, creditsFinal = null, error = null }) {
    await pool.query(
        `UPDATE enrow_requests SET
            status = $2, found = COALESCE($3, found), credits_final = COALESCE($4, credits_final),
            error = $5, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [id, status, found, creditsFinal, error]
    );
}

export async function touchEnrowRequest(id) {
    await pool.query(`UPDATE enrow_requests SET updated_at = NOW() WHERE id = $1`, [id]);
}

/**
 * Write Enrow finder hits, then stamp every submitted contact as attempted.
 * One row at a time: the address may already belong to another contact in the
 * agency (ux_contacts_agency_email), and one collision must not roll back the
 * rest — such rows are skipped and counted.
 *
 * @param {string} agencyId
 * @param {string[]} contactIds all submitted contacts
 * @param {Array<{ contactId: string, email: string }>} found
 * @returns {Promise<{ written: number, duplicates: number }>}
 */
export async function applyEnrowFindResults(agencyId, contactIds, found) {
    let written = 0;
    let duplicates = 0;
    const client = await pool.connect();
    try {
        for (const { contactId, email } of found) {
            // Enrow only returns deliverable addresses, so the hit is stamped as a
            // verification result — the TryKitt verify queue skips it.
            let res;
            try {
                res = await client.query(
                    `UPDATE contacts c SET
                        email = $3,
                        email_status = 'valid',
                        email_source = 'enrow',
                        email_verify_source = 'enrow',
                        email_verify_completed_at = NOW(),
                        enrow_find_attempted_at = NOW(),
                        updated_at = NOW()
                     WHERE c.id = $2::bigint AND c.agency_id = $1
                       AND (c.email IS NULL OR BTRIM(c.email) = '')
                       AND NOT EXISTS (
                           SELECT 1 FROM contacts o
                           WHERE o.agency_id = $1 AND o.id <> c.id
                             AND o.email IS NOT NULL AND BTRIM(o.email) <> ''
                             AND LOWER(o.email) = LOWER($3)
                       )`,
                    [agencyId, contactId, email]
                );
            } catch (err) {
                // Lost a race with a concurrent insert of the same address.
                if (err?.code !== '23505') throw err;
                res = { rowCount: 0 };
            }
            if (res.rowCount) written += 1;
            else duplicates += 1;
        }
        if (contactIds.length) {
            await client.query(
                `UPDATE contacts SET enrow_find_attempted_at = NOW(), updated_at = NOW()
                 WHERE agency_id = $1 AND id = ANY($2::bigint[])`,
                [agencyId, contactIds]
            );
        }
    } finally {
        client.release();
    }
    return { written, duplicates };
}

/**
 * Write Enrow verifier verdicts and stamp every submitted contact as attempted.
 * Guarded on the email still matching what was submitted.
 *
 * @param {string} agencyId
 * @param {Array<{ contact_id: string, email: string }>} items all submitted items
 * @param {Array<{ contactId: string, status: 'valid' | 'invalid' }>} verdicts
 * @returns {Promise<{ valid: number, invalid: number }>}
 */
export async function applyEnrowVerifyResults(agencyId, items, verdicts) {
    const emailById = new Map(items.map((i) => [String(i.contact_id), i.email]));
    const ids = [];
    const statuses = [];
    const emails = [];
    for (const v of verdicts) {
        const email = emailById.get(v.contactId);
        if (!email) continue;
        ids.push(v.contactId);
        statuses.push(v.status);
        emails.push(email);
    }
    const counts = { valid: 0, invalid: 0 };
    if (ids.length) {
        const res = await pool.query(
            `UPDATE contacts c SET
                email_status = v.status,
                email_verify_source = 'enrow',
                enrow_verify_attempted_at = NOW(),
                updated_at = NOW()
             FROM unnest($2::bigint[], $3::text[], $4::text[]) AS v(id, status, email)
             WHERE c.id = v.id AND c.agency_id = $1 AND LOWER(c.email) = LOWER(v.email)
             RETURNING v.status`,
            [agencyId, ids, statuses, emails]
        );
        for (const row of res.rows) counts[row.status] += 1;
    }
    const allIds = items.map((i) => String(i.contact_id));
    if (allIds.length) {
        await pool.query(
            `UPDATE contacts SET enrow_verify_attempted_at = NOW(), updated_at = NOW()
             WHERE agency_id = $1 AND id = ANY($2::bigint[])`,
            [agencyId, allIds]
        );
    }
    return counts;
}
