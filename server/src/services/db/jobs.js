/**
 * SQL job orchestration — replaces Firestore jobs / activeJob / jobQueue.
 */

import { pool } from '../../config/db.js';
import { normalizeDomain } from '../../utils/domain.js';
import { parse as csvParse } from 'csv-parse/sync';
import { mergeEnrichmentIntoRawRow } from '../enrichmentCohort.js';

/** Domains eligible for enrichment stages (cohort + not founder-excluded this job). */
const COHORT_ELIGIBLE_SQL = `
    AND COALESCE(jd.raw_row->'_enrichment'->>'founderExcluded', 'false') <> 'true'
    AND COALESCE(jd.raw_row->'_enrichment'->>'inEmailCohort', 'true') = 'true'`;

export function jobRowToState(row) {
    if (!row) return null;
    const options = row.options || {};
    return {
        id: row.id,
        status: row.status,
        error: row.error,
        paused: !!row.paused,
        pausedAt: row.paused_at ? new Date(row.paused_at).toISOString() : null,
        resumedAt: row.resumed_at ? new Date(row.resumed_at).toISOString() : null,
        cancelled: !!row.cancelled,
        fileName: row.file_name,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
        stages: row.stages || {},
        activityMessage: options.activityMessage || null,
        activityUpdatedAt: options.activityUpdatedAt || null,
        dedupeStats: row.dedupe_stats || null,
        dedupeStrategy: options.dedupeStrategy || 'skip',
        sqlClientId: row.client_id,
        clientId: row.client_slug,
        uid: row.agency_id,
        skipFounderFinder: !!options.skipFounderFinder,
        skipEmailFinder: !!options.skipEmailFinder,
        skipVerification: !!options.skipVerification,
        findFounder: options.findFounder !== false,
        emailVerificationProvider: options.emailVerificationProvider || 'trykitt',
        columnMapping: options.columnMapping || { domain: 'domain', founder: '', email: '' },
        industry: options.industry || null,
        nicheId: options.nicheId || null,
        nicheLabel: options.nicheLabel || null,
        personalizeFirstLine: !!options.personalizeFirstLine,
        productPromptVersion: options.productPromptVersion || 'old',
        productPromptProducts: options.productPromptProducts,
        skipDomainCheck: !!options.skipDomainCheck,
        cost: Number(row.cost) || 0,
        uploadStatus: row.upload_status,
        isActive: !!row.is_active
    };
}

export function inMemoryJobFromRow(row, apiKeys = {}) {
    const base = jobRowToState(row);
    if (!base) return null;
    const options = row.options || {};
    return {
        ...base,
        apiKeys,
        pricing: null,
        tmpDir: null,
        paths: {},
        __persistedOnce: true,
        __updateCounter: 0,
        __lastStatus: base.status,
        dedupeStrategy: options.dedupeStrategy || 'skip',
        skipFounderFinder: !!options.skipFounderFinder,
        skipEmailFinder: !!options.skipEmailFinder,
        skipVerification: !!options.skipVerification,
        skipDomainCheck: !!options.skipDomainCheck,
        findFounder: options.findFounder !== false,
        industry: options.industry || options.nicheId || null,
        nicheId: options.nicheId || null,
        nicheLabel: options.nicheLabel || null,
        personalizeFirstLine: !!options.personalizeFirstLine,
        productPromptVersion: options.productPromptVersion || 'old',
        productPromptProducts: Number.isFinite(options.productPromptProducts) ? options.productPromptProducts : 3,
        emailVerificationProvider: options.emailVerificationProvider || 'trykitt',
        columnMapping: options.columnMapping || { domain: 'domain', founder: '', email: '' }
    };
}

export function parseDomainsFromBuffer(buffer, domainColumn = 'domain') {
    const text = Buffer.isBuffer(buffer) ? buffer.toString('utf-8') : String(buffer || '');
    const records = csvParse(text, { columns: true, skip_empty_lines: true, trim: true });
    const seen = new Set();
    const domains = [];
    for (const row of records) {
        const domain = normalizeDomain(row[domainColumn] || row.domain);
        if (domain && !seen.has(domain)) {
            seen.add(domain);
            domains.push({ domain, raw: row });
        }
    }
    return domains;
}

export async function insertJob({
    id,
    agencyId,
    clientId,
    clientSlug,
    fileName,
    options = {},
    status = 'queued'
}) {
    await pool.query(
        `INSERT INTO jobs (
            id, agency_id, client_id, client_slug, status, file_name, options, stages
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
        [
            id,
            agencyId,
            clientId,
            clientSlug,
            status,
            fileName,
            JSON.stringify(options),
            JSON.stringify(options.initialStages || {})
        ]
    );
}

export async function bulkInsertJobDomains(jobId, agencyId, domainEntries) {
    if (!domainEntries.length) return 0;
    const CHUNK = 500;
    let inserted = 0;
    for (let i = 0; i < domainEntries.length; i += CHUNK) {
        const chunk = domainEntries.slice(i, i + CHUNK);
        const values = [];
        const params = [jobId, agencyId];
        let idx = 3;
        for (let j = 0; j < chunk.length; j++) {
            const entry = chunk[j];
            values.push(`($1, $2, $${idx}, 'pending', $${idx + 1}, $${idx + 2}::jsonb)`);
            params.push(entry.domain, i + j, entry.raw ? JSON.stringify(entry.raw) : '{}');
            idx += 3;
        }
        await pool.query(
            `INSERT INTO job_domains (job_id, agency_id, domain_normalized, status, sort_order, raw_row)
             VALUES ${values.join(', ')}
             ON CONFLICT (job_id, domain_normalized) DO NOTHING`,
            params
        );
        inserted += chunk.length;
    }
    return inserted;
}

export async function markJobDomainsSkipped(jobId, domains) {
    if (!domains?.length) return;
    await pool.query(
        `UPDATE job_domains SET status = 'skipped', updated_at = NOW()
         WHERE job_id = $1 AND domain_normalized = ANY($2::text[])`,
        [jobId, domains]
    );
}

export async function listPendingJobDomains(jobId, limit = 10000) {
    const result = await pool.query(
        `SELECT domain_normalized, raw_row, sort_order
         FROM job_domains
         WHERE job_id = $1 AND status = 'pending'
         ORDER BY sort_order ASC
         LIMIT $2`,
        [jobId, limit]
    );
    return result.rows;
}

export async function countJobDomainsByStatus(jobId) {
    const result = await pool.query(
        `SELECT status, COUNT(*)::int AS count
         FROM job_domains WHERE job_id = $1 GROUP BY status`,
        [jobId]
    );
    const map = { pending: 0, processing: 0, done: 0, skipped: 0 };
    for (const row of result.rows) {
        map[row.status] = row.count;
    }
    return map;
}

export async function markJobDomainProcessing(jobId, domain) {
    await pool.query(
        `UPDATE job_domains SET status = 'processing', updated_at = NOW()
         WHERE job_id = $1 AND domain_normalized = $2`,
        [jobId, domain]
    );
}

const DOMAIN_STATUS_BATCH = 500;

export async function markJobDomainDone(jobId, domain) {
    await markJobDomainsDone(jobId, [domain]);
}

/** Mark many job_domains rows done in chunked UPDATEs. */
export async function markJobDomainsDone(jobId, domains) {
    if (!domains?.length) return;
    for (let offset = 0; offset < domains.length; offset += DOMAIN_STATUS_BATCH) {
        const chunk = domains.slice(offset, offset + DOMAIN_STATUS_BATCH);
        await pool.query(
            `UPDATE job_domains SET status = 'done', updated_at = NOW()
             WHERE job_id = $1 AND domain_normalized = ANY($2::text[])`,
            [jobId, chunk]
        );
    }
}

/** Stamp founderExcluded on many domains (CSV "Not Found" founder). */
export async function markJobDomainsFounderExcluded(jobId, domains) {
    if (!domains?.length) return;
    for (let offset = 0; offset < domains.length; offset += DOMAIN_STATUS_BATCH) {
        const chunk = domains.slice(offset, offset + DOMAIN_STATUS_BATCH);
        await pool.query(
            `UPDATE job_domains
             SET raw_row = jsonb_set(
                     COALESCE(raw_row, '{}'::jsonb),
                     '{_enrichment,founderExcluded}',
                     'true'::jsonb,
                     true
                 ),
                 updated_at = NOW()
             WHERE job_id = $1 AND domain_normalized = ANY($2::text[])`,
            [jobId, chunk]
        );
    }
}

export async function loadSerperCacheMap(jobId) {
    const result = await pool.query(
        `SELECT domain_normalized, payload FROM job_serper_cache WHERE job_id = $1`,
        [jobId]
    );
    const map = {};
    for (const row of result.rows) {
        map[row.domain_normalized] = row.payload || {};
    }
    return map;
}

export async function upsertSerperCacheBatch(jobId, entries) {
    if (!entries.length) return;
    const values = [];
    const params = [jobId];
    let idx = 2;
    for (const { domain, payload } of entries) {
        values.push(`($1, $${idx}, $${idx + 1}::jsonb)`);
        params.push(domain, JSON.stringify(payload || {}));
        idx += 2;
    }
    await pool.query(
        `INSERT INTO job_serper_cache (job_id, domain_normalized, payload)
         VALUES ${values.join(', ')}
         ON CONFLICT (job_id, domain_normalized)
         DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        params
    );
}

export async function persistJobState(job) {
    const options = {
        dedupeStrategy: job.dedupeStrategy,
        skipFounderFinder: job.skipFounderFinder,
        skipEmailFinder: job.skipEmailFinder,
        skipVerification: job.skipVerification,
        skipDomainCheck: job.skipDomainCheck,
        findFounder: job.findFounder,
        emailVerificationProvider: job.emailVerificationProvider,
        columnMapping: job.columnMapping,
        industry: job.industry,
        nicheId: job.nicheId,
        nicheLabel: job.nicheLabel,
        personalizeFirstLine: job.personalizeFirstLine,
        productPromptVersion: job.productPromptVersion,
        productPromptProducts: job.productPromptProducts,
        activityMessage: job.activity?.message || null,
        activityUpdatedAt: job.activity?.updatedAt || null
    };

    await pool.query(
        `UPDATE jobs SET
            status = $2,
            paused = $3,
            cancelled = $4,
            error = $5,
            cost = $6,
            stages = $7::jsonb,
            dedupe_stats = $8::jsonb,
            options = $9::jsonb,
            updated_at = NOW(),
            completed_at = CASE WHEN $10::timestamptz IS NOT NULL THEN $10::timestamptz ELSE completed_at END,
            paused_at = CASE WHEN $11::timestamptz IS NOT NULL THEN $11::timestamptz ELSE paused_at END,
            resumed_at = CASE WHEN $12::timestamptz IS NOT NULL THEN $12::timestamptz ELSE resumed_at END
         WHERE id = $1`,
        [
            job.id,
            job.status,
            !!job.paused,
            !!job.cancelled,
            job.error || null,
            typeof job.cost === 'number' ? job.cost : 0,
            JSON.stringify(job.stages || {}),
            job.dedupeStats ? JSON.stringify(job.dedupeStats) : null,
            JSON.stringify(options),
            job.completedAt || null,
            job.pausedAt || null,
            job.resumedAt || null
        ]
    );
}

export async function setActiveJob(jobId, agencyId, clientId) {
    await pool.query(
        `UPDATE jobs SET is_active = FALSE, updated_at = NOW()
         WHERE agency_id = $1 AND client_id = $2 AND is_active = TRUE`,
        [agencyId, clientId]
    );
    await pool.query(
        `UPDATE jobs SET is_active = TRUE, updated_at = NOW() WHERE id = $1`,
        [jobId]
    );
}

export async function updateActiveJobStatus(jobId, uploadStatus, extra = {}) {
    await pool.query(
        `UPDATE jobs SET
            upload_status = COALESCE($2, upload_status),
            upload_error = COALESCE($3, upload_error),
            upload_metrics = COALESCE($4::jsonb, upload_metrics),
            status = COALESCE($5, status),
            updated_at = NOW()
         WHERE id = $1`,
        [
            jobId,
            uploadStatus ?? null,
            extra.uploadError ?? null,
            extra.uploadMetrics ? JSON.stringify(extra.uploadMetrics) : null,
            extra.status ?? null
        ]
    );
}

export async function getJobById(jobId, agencyId = null) {
    const params = [jobId];
    let sql = `SELECT * FROM jobs WHERE id = $1`;
    if (agencyId) {
        sql += ` AND agency_id = $2`;
        params.push(agencyId);
    }
    const result = await pool.query(sql, params);
    return result.rows[0] || null;
}

export async function getActiveJobForClient(agencyId, clientId) {
    const result = await pool.query(
        `SELECT * FROM jobs
         WHERE agency_id = $1 AND client_id = $2 AND is_active = TRUE
         ORDER BY updated_at DESC LIMIT 1`,
        [agencyId, clientId]
    );
    return result.rows[0] || null;
}

export async function listJobsForClient(agencyId, clientId, limit = 50) {
    const result = await pool.query(
        `SELECT * FROM jobs
         WHERE agency_id = $1 AND client_id = $2
         ORDER BY created_at DESC LIMIT $3`,
        [agencyId, clientId, limit]
    );
    return result.rows;
}

export async function syncJobControlFromDb(job) {
    const row = await getJobById(job.id);
    if (!row) return null;
    job.paused = !!row.paused;
    job.cancelled = !!row.cancelled;
    job.status = row.status || job.status;
    return { paused: job.paused, cancelled: job.cancelled };
}

export async function updateJobControl(jobId, { paused, cancelled }) {
    const sets = [];
    const params = [jobId];
    let idx = 2;
    if (paused !== undefined) {
        sets.push(`paused = $${idx}`);
        params.push(!!paused);
        idx++;
        if (paused) {
            sets.push(`paused_at = NOW()`);
        }
    }
    if (cancelled !== undefined) {
        sets.push(`cancelled = $${idx}`);
        params.push(!!cancelled);
        idx++;
    }
    sets.push('updated_at = NOW()');
    await pool.query(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $1`, params);

    await pool.query(
        `UPDATE job_queue SET
            control = control || $2::jsonb,
            updated_at = NOW()
         WHERE job_id = $1`,
        [jobId, JSON.stringify({
            ...(paused !== undefined ? { paused: !!paused } : {}),
            ...(cancelled !== undefined ? { cancelled: !!cancelled } : {})
        })]
    );
}

const COHORT_ENRICH_CHUNK = 500;

/**
 * Stamp _enrichment cohort flags on every job_domains.raw_row from CSV + column mapping.
 */
export async function enrichJobDomainCohortFlags(jobId, columnMapping = {}, onProgress) {
    const result = await pool.query(
        `SELECT domain_normalized, raw_row FROM job_domains WHERE job_id = $1`,
        [jobId]
    );
    const rows = result.rows;
    if (!rows.length) return 0;

    for (let offset = 0; offset < rows.length; offset += COHORT_ENRICH_CHUNK) {
        const chunk = rows.slice(offset, offset + COHORT_ENRICH_CHUNK);
        const domains = [];
        const payloads = [];
        for (const row of chunk) {
            domains.push(row.domain_normalized);
            payloads.push(JSON.stringify(mergeEnrichmentIntoRawRow(row.raw_row || {}, columnMapping)));
        }
        await pool.query(
            `UPDATE job_domains AS jd
             SET raw_row = v.raw_row::jsonb, updated_at = NOW()
             FROM UNNEST($2::text[], $3::text[]) AS v(domain_normalized, raw_row)
             WHERE jd.job_id = $1 AND jd.domain_normalized = v.domain_normalized`,
            [jobId, domains, payloads]
        );
        if (typeof onProgress === 'function') {
            const processed = Math.min(offset + chunk.length, rows.length);
            await onProgress({ processed, total: rows.length });
        }
    }
    return rows.length;
}

export async function markJobDomainFounderExcluded(jobId, domainNormalized) {
    await markJobDomainsFounderExcluded(jobId, [domainNormalized]);
}

export async function listJobDomainsForJob(jobId, { emailCohortOnly = false } = {}) {
    const cohortFilter = emailCohortOnly
        ? `AND COALESCE(raw_row->'_enrichment'->>'inEmailCohort', 'true') = 'true'
           AND COALESCE(raw_row->'_enrichment'->>'founderExcluded', 'false') <> 'true'`
        : '';
    const result = await pool.query(
        `SELECT domain_normalized, raw_row, status
         FROM job_domains
         WHERE job_id = $1 ${cohortFilter}
         ORDER BY sort_order ASC`,
        [jobId]
    );
    return result.rows;
}

/** True when enrichment stages still have rows to process (resume / recovery). */
export async function jobHasRemainingPipelineWork({
    agencyId,
    clientId,
    jobId,
    skipVerification = false,
    personalizeFirstLine = false,
    dedupeStrategy = 'skip'
}) {
    const reprocessInclude = String(dedupeStrategy || 'skip').toLowerCase() === 'include';
    const limit = 1;
    const [emailRows, verifyRows, pending] = await Promise.all([
        getEmailFindQueue(agencyId, clientId, jobId, { reprocessInclude, limit }),
        skipVerification
            ? Promise.resolve([])
            : getVerifyQueue(agencyId, clientId, jobId, { reprocessInclude, limit }),
        listPendingJobDomains(jobId, limit)
    ]);
    if (emailRows.length || verifyRows.length || pending.length) {
        return true;
    }
    if (personalizeFirstLine) {
        const personalizeRows = await getPersonalizeQueue(agencyId, clientId, jobId, { reprocessInclude, limit });
        if (personalizeRows.length) return true;
    }
    return false;
}

export async function getEmailFindQueue(agencyId, clientId, jobId, { reprocessInclude = false, limit = 5000 } = {}) {
    const emailConstraint = reprocessInclude
        ? ''
        : `AND (c.email IS NULL OR BTRIM(c.email) = '') AND c.email_find_completed_at IS NULL`;

    const result = await pool.query(
        `SELECT c.id AS contact_id, co.domain_normalized AS domain, c.full_name AS founder_name
         FROM contacts c
         JOIN companies co ON co.id = c.company_id
         JOIN job_domains jd ON jd.job_id = $3 AND jd.domain_normalized = co.domain_normalized
         WHERE c.agency_id = $1 AND c.client_id = $2 AND c.job_id = $3
           AND c.role_type = 'founder'
           ${emailConstraint}
           AND (c.full_name IS NOT NULL AND BTRIM(c.full_name) <> '' AND LOWER(BTRIM(c.full_name)) <> 'not found')
           AND COALESCE(jd.raw_row->'_enrichment'->>'inFounderCohort', 'true') = 'true'
           ${COHORT_ELIGIBLE_SQL}
         ORDER BY c.id ASC
         LIMIT $4`,
        [agencyId, clientId, jobId, limit]
    );
    return result.rows;
}

export async function getVerifyQueue(agencyId, clientId, jobId, { reprocessInclude = false, limit = 5000 } = {}) {
    const freshnessConstraint = reprocessInclude
        ? ''
        : `AND c.email_verify_completed_at IS NULL`;

    const result = await pool.query(
        `SELECT c.id AS contact_id, co.domain_normalized AS domain, c.full_name AS founder_name,
                c.email, c.email_status
         FROM contacts c
         JOIN companies co ON co.id = c.company_id
         JOIN job_domains jd ON jd.job_id = $3 AND jd.domain_normalized = co.domain_normalized
         WHERE c.agency_id = $1 AND c.client_id = $2 AND c.job_id = $3
           AND c.role_type = 'founder'
           AND c.email IS NOT NULL AND BTRIM(c.email) <> ''
           AND LOWER(BTRIM(COALESCE(c.full_name, ''))) <> 'not found'
           ${freshnessConstraint}
           ${COHORT_ELIGIBLE_SQL}
         ORDER BY c.id ASC
         LIMIT $4`,
        [agencyId, clientId, jobId, limit]
    );
    return result.rows;
}

export async function getPersonalizeQueue(
    agencyId,
    clientId,
    jobId,
    { reprocessInclude = false, requireValidEmail = false, limit = 5000 } = {}
) {
    const personalizationFilter = reprocessInclude
        ? ''
        : `AND (c.personalization_first_line IS NULL OR BTRIM(c.personalization_first_line) = '')`;
    const emailStatusFilter = requireValidEmail
        ? `AND LOWER(TRIM(COALESCE(c.email_status, ''))) IN ('valid', 'valid-risky')`
        : '';

    const result = await pool.query(
        `SELECT c.id AS contact_id, co.domain_normalized AS domain, c.full_name AS founder_name,
                c.email, c.email_status, c.personalization_first_line
         FROM contacts c
         JOIN companies co ON co.id = c.company_id
         JOIN job_domains jd ON jd.job_id = $3 AND jd.domain_normalized = co.domain_normalized
         WHERE c.agency_id = $1 AND c.client_id = $2 AND c.job_id = $3
           AND c.role_type = 'founder'
           AND c.email IS NOT NULL AND BTRIM(c.email) <> ''
           AND LOWER(BTRIM(COALESCE(c.full_name, ''))) <> 'not found'
           ${personalizationFilter}
           ${emailStatusFilter}
           ${COHORT_ELIGIBLE_SQL}
         ORDER BY c.id ASC
         LIMIT $4`,
        [agencyId, clientId, jobId, limit]
    );
    return result.rows;
}

export async function buildUnifiedRowsFromDb(jobId, scope = 'valid') {
    let statusFilter = '';
    if (scope === 'valid') {
        statusFilter = `AND c.email_status IN ('valid', 'risky')`;
    } else if (scope === 'complete') {
        statusFilter = `AND c.email IS NOT NULL AND BTRIM(c.email) <> ''
            AND c.personalization_first_line IS NOT NULL AND BTRIM(c.personalization_first_line) <> ''`;
    }

    const result = await pool.query(
        `SELECT
            co.domain_normalized AS domain,
            c.full_name AS founder_name,
            c.email,
            c.email_status,
            c.personalization_first_line AS personalization,
            c.personalization_first_line AS first_line
         FROM contacts c
         JOIN companies co ON co.id = c.company_id
         WHERE c.job_id = $1 AND c.role_type = 'founder'
         ${statusFilter}
         ORDER BY co.domain_normalized ASC`,
        [jobId]
    );

    return result.rows.map((row) => {
        const parts = String(row.founder_name || '').trim().split(/\s+/);
        const firstName = parts[0] || '';
        const lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';
        return {
            domain: row.domain,
            founder_name: row.founder_name || '',
            email: row.email || '',
            email_status: row.email_status || '',
            first_name: firstName,
            last_name: lastName,
            personalization: row.personalization || row.first_line || ''
        };
    });
}

export async function deleteJobFromDb(jobId, agencyId) {
    await pool.query(`DELETE FROM job_domains WHERE job_id = $1`, [jobId]);
    await pool.query(`DELETE FROM job_serper_cache WHERE job_id = $1`, [jobId]);
    await pool.query(`DELETE FROM job_queue WHERE job_id = $1`, [jobId]);
    await pool.query(`DELETE FROM jobs WHERE id = $1 AND agency_id = $2`, [jobId, agencyId]);
}

export async function clearActiveJobForClient(agencyId, clientId, { jobId = null, uploadStatus = null } = {}) {
    if (jobId) {
        await pool.query(
            `UPDATE jobs SET
                is_active = false,
                upload_status = COALESCE($4, upload_status),
                upload_error = NULL,
                upload_metrics = NULL,
                updated_at = NOW()
             WHERE agency_id = $1 AND client_id = $2 AND id = $3`,
            [agencyId, clientId, jobId, uploadStatus]
        );
    }
    await pool.query(
        `UPDATE jobs SET is_active = false, updated_at = NOW()
         WHERE agency_id = $1 AND client_id = $2 AND is_active = TRUE`,
        [agencyId, clientId]
    );
}
