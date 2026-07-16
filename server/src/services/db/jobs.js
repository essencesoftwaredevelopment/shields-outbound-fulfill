/**
 * SQL job orchestration — replaces Firestore jobs / activeJob / jobQueue.
 */

import { pool } from '../../config/db.js';
import { normalizeDomain } from '../../utils/domain.js';
import { parse as csvParse } from 'csv-parse/sync';
import { mergeEnrichmentIntoRawRow } from '../enrichmentCohort.js';
import { SIGNAL_ISSUE_LABELS } from '../shoppingAudit/constants.js';
import { formatPriceUsd } from '../shoppingAudit/utils.js';

/** Domains eligible for enrichment stages (cohort + not founder-excluded this job). */
const COHORT_ELIGIBLE_SQL = `
    AND COALESCE(jd.raw_row->'_enrichment'->>'founderExcluded', 'false') <> 'true'
    AND COALESCE(jd.raw_row->'_enrichment'->>'inEmailCohort', 'true') = 'true'`;

/**
 * job_domains marked `skipped` must never re-enter enrichment queues — whether
 * skipped by dedupe (skip mode) or by the shopping-audit matched-only gate.
 * Reprocess mode used to bypass this, but reprocess dedupe marks nothing as
 * skipped, so the bypass only ever leaked audit-skipped (unmatched) domains
 * into email/verification queues.
 */
function skippedJobDomainSql() {
    return `AND jd.status <> 'skipped'`;
}

function resolvePipelineMode(options = {}, stages = {}) {
    if (options.pipelineMode === 'shopping_audit') return 'shopping_audit';
    if (options.nicheId === 'shopping_audit' || options.industry === 'shopping_audit') {
        return 'shopping_audit';
    }
    if (stages?.shopifyCatalog) return 'shopping_audit';
    return options.pipelineMode || 'standard';
}

export function jobRowToState(row) {
    if (!row) return null;
    const options = row.options || {};
    const stages = row.stages || {};
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
        timingLog: Array.isArray(options.timingLog) ? options.timingLog : [],
        timingTotals: options.timingTotals && typeof options.timingTotals === 'object'
            ? options.timingTotals
            : {},
        dedupeStats: row.dedupe_stats || null,
        dedupeStrategy: options.dedupeStrategy || 'skip',
        pipelineMode: resolvePipelineMode(options, stages),
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
        isActive: !!row.is_active,
        executionRunner: options.executionRunner || 'pm2'
    };
}

export function inMemoryJobFromRow(row, apiKeys = {}) {
    const base = jobRowToState(row);
    if (!base) return null;
    const options = row.options || {};
    const timing = {
        timingLog: Array.isArray(options.timingLog) ? options.timingLog : [],
        timingTotals: options.timingTotals && typeof options.timingTotals === 'object'
            ? options.timingTotals
            : {}
    };
    return {
        ...base,
        ...timing,
        apiKeys,
        pricing: null,
        tmpDir: null,
        paths: {},
        __persistedOnce: true,
        __updateCounter: 0,
        __lastStatus: base.status,
        dedupeStrategy: options.dedupeStrategy || 'skip',
        pipelineMode: resolvePipelineMode(options, row.stages || {}),
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

/**
 * List pending job_domains rows for a job.
 * @param {string} jobId
 * @param {number|null|undefined} [limit] - When set, caps rows returned (e.g. 1 for existence checks).
 *   Omit to return all pending domains — required for uploads larger than 10k.
 */
export async function listPendingJobDomains(jobId, limit) {
    const params = [jobId];
    let sql = `SELECT domain_normalized, raw_row, sort_order
         FROM job_domains
         WHERE job_id = $1 AND status = 'pending'
         ORDER BY sort_order ASC`;
    if (limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0) {
        sql += ' LIMIT $2';
        params.push(Number(limit));
    }
    const result = await pool.query(sql, params);
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

export async function persistJobState(job, { includeTiming = true } = {}) {
    const activityFields = {
        activityMessage: job.activity?.message || null,
        activityUpdatedAt: job.activity?.updatedAt || null
    };

    const optionsPatch = includeTiming
        ? {
            dedupeStrategy: job.dedupeStrategy,
            pipelineMode: job.pipelineMode || 'standard',
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
            ...activityFields,
            timingLog: Array.isArray(job.timingLog) ? job.timingLog : [],
            timingTotals: job.timingTotals && typeof job.timingTotals === 'object' ? job.timingTotals : {}
        }
        : activityFields;

    await pool.query(
        `UPDATE jobs SET
            status = $2,
            paused = $3,
            cancelled = $4,
            error = $5,
            cost = $6,
            stages = $7::jsonb,
            dedupe_stats = $8::jsonb,
            options = COALESCE(options, '{}'::jsonb) || $9::jsonb,
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
            JSON.stringify(optionsPatch),
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

export async function listJobDomainsForJob(jobId, { emailCohortOnly = false, excludeSkipped = false } = {}) {
    const cohortFilter = emailCohortOnly
        ? `AND COALESCE(raw_row->'_enrichment'->>'inEmailCohort', 'true') = 'true'
           AND COALESCE(raw_row->'_enrichment'->>'founderExcluded', 'false') <> 'true'`
        : '';
    const skippedFilter = excludeSkipped ? `AND status <> 'skipped'` : '';
    const result = await pool.query(
        `SELECT domain_normalized, raw_row, status
         FROM job_domains
         WHERE job_id = $1 ${cohortFilter} ${skippedFilter}
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
    dedupeStrategy = 'skip',
    jobStartedAt = null
}) {
    const reprocessInclude = String(dedupeStrategy || 'skip').toLowerCase() === 'include';
    const limit = 1;
    const opts = { reprocessInclude, limit, jobStartedAt };
    const [emailRows, verifyRows, pending] = await Promise.all([
        getEmailFindQueue(agencyId, clientId, jobId, opts),
        skipVerification
            ? Promise.resolve([])
            : getVerifyQueue(agencyId, clientId, jobId, opts),
        listPendingJobDomains(jobId, limit)
    ]);
    if (emailRows.length || verifyRows.length || pending.length) {
        return true;
    }
    if (personalizeFirstLine) {
        const personalizeRows = await getPersonalizeQueue(agencyId, clientId, jobId, opts);
        if (personalizeRows.length) return true;
    }
    return false;
}

/** Shared cohort for email discovery (scoped by this job's domains, not contacts.job_id). */
const EMAIL_DISCOVERY_COHORT_SQL = `
    FROM contacts c
    JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
    JOIN job_domains jd ON jd.job_id = $3 AND jd.domain_normalized = co.domain_normalized
    WHERE c.agency_id = $1 AND c.client_id = $2
      AND c.role_type = 'founder'
      AND c.full_name IS NOT NULL AND BTRIM(c.full_name) <> ''
      AND LOWER(BTRIM(c.full_name)) <> 'not found'
      AND COALESCE(jd.raw_row->'_enrichment'->>'inFounderCohort', 'true') = 'true'
      ${COHORT_ELIGIBLE_SQL}`;

/** Founders in this job's upload cohort eligible for email discovery. */
export async function countEmailDiscoveryEligibleForJob(agencyId, clientId, jobId) {
    const result = await pool.query(
        `SELECT COUNT(DISTINCT c.id)::int AS count ${EMAIL_DISCOVERY_COHORT_SQL}`,
        [agencyId, clientId, jobId]
    );
    return result.rows[0]?.count ?? 0;
}

/** Founders in this job's cohort that already finished email discovery (any outcome). */
export async function countEmailFindCompletedForJob(agencyId, clientId, jobId) {
    const result = await pool.query(
        `SELECT COUNT(DISTINCT c.id)::int AS count ${EMAIL_DISCOVERY_COHORT_SQL}
           AND c.email_find_completed_at IS NOT NULL`,
        [agencyId, clientId, jobId]
    );
    return result.rows[0]?.count ?? 0;
}

/**
 * Queue email-finder work for a job.
 *
 * - In skip mode (`reprocessInclude=false`): exclude any contact already completed.
 * - In reprocess mode (`reprocessInclude=true`):
 *   - If `jobStartedAt` is given, exclude rows whose `email_find_completed_at` is at or
 *     after that timestamp (i.e. processed during THIS run). Stale completions from
 *     prior jobs (or NULL) are queued for refresh.
 *   - If no `jobStartedAt` is given, return everything (legacy behavior, full reprocess).
 */
export async function getEmailFindQueue(
    agencyId,
    clientId,
    jobId,
    { reprocessInclude = false, limit = 5000, jobStartedAt = null } = {}
) {
    const params = [agencyId, clientId, jobId, limit];
    let emailConstraint;
    if (reprocessInclude) {
        if (jobStartedAt) {
            params.push(jobStartedAt);
            emailConstraint = `AND (c.email_find_completed_at IS NULL OR c.email_find_completed_at < $5::timestamptz)`;
        } else {
            emailConstraint = '';
        }
    } else {
        emailConstraint = `AND (c.email IS NULL OR BTRIM(c.email) = '') AND c.email_find_completed_at IS NULL`;
    }

    const result = await pool.query(
        `SELECT DISTINCT ON (c.id)
                c.id AS contact_id,
                co.domain_normalized AS domain,
                c.full_name AS founder_name
         FROM contacts c
         JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
         JOIN job_domains jd ON jd.job_id = $3 AND jd.domain_normalized = co.domain_normalized
         WHERE c.agency_id = $1 AND c.client_id = $2
           AND c.role_type = 'founder'
           ${emailConstraint}
           AND (c.full_name IS NOT NULL AND BTRIM(c.full_name) <> '' AND LOWER(BTRIM(c.full_name)) <> 'not found')
           AND COALESCE(jd.raw_row->'_enrichment'->>'inFounderCohort', 'true') = 'true'
           ${COHORT_ELIGIBLE_SQL}
           ${skippedJobDomainSql()}
         ORDER BY c.id ASC
         LIMIT $4`,
        params
    );
    return result.rows;
}

/** Same job-scoped resume semantics as `getEmailFindQueue` for verification. */
export async function getVerifyQueue(
    agencyId,
    clientId,
    jobId,
    { reprocessInclude = false, limit = 5000, jobStartedAt = null } = {}
) {
    const params = [agencyId, clientId, jobId, limit];
    let freshnessConstraint;
    if (reprocessInclude) {
        if (jobStartedAt) {
            params.push(jobStartedAt);
            freshnessConstraint = `AND (c.email_verify_completed_at IS NULL OR c.email_verify_completed_at < $5::timestamptz)`;
        } else {
            freshnessConstraint = '';
        }
    } else {
        freshnessConstraint = `AND c.email_verify_completed_at IS NULL`;
    }

    const result = await pool.query(
        `SELECT DISTINCT ON (c.id)
                c.id AS contact_id,
                co.domain_normalized AS domain,
                c.full_name AS founder_name,
                c.email,
                c.email_status
         FROM contacts c
         JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
         JOIN job_domains jd ON jd.job_id = $3 AND jd.domain_normalized = co.domain_normalized
         WHERE c.agency_id = $1 AND c.client_id = $2
           AND c.role_type = 'founder'
           AND c.email IS NOT NULL AND BTRIM(c.email) <> ''
           AND LOWER(BTRIM(COALESCE(c.full_name, ''))) <> 'not found'
           ${freshnessConstraint}
           ${COHORT_ELIGIBLE_SQL}
           ${skippedJobDomainSql()}
         ORDER BY c.id ASC
         LIMIT $4`,
        params
    );
    return result.rows;
}

export async function getPersonalizeQueue(
    agencyId,
    clientId,
    jobId,
    { reprocessInclude = false, requireValidEmail = false, limit = 5000, jobStartedAt = null } = {}
) {
    const params = [agencyId, clientId, jobId, limit];
    let personalizationFilter;
    if (reprocessInclude) {
        if (jobStartedAt) {
            // Skip rows already personalized in THIS run (resume), re-do prior-run rows.
            params.push(jobStartedAt);
            personalizationFilter = `AND (c.personalization_completed_at IS NULL OR c.personalization_completed_at < $${params.length}::timestamptz)`;
        } else {
            personalizationFilter = ''; // legacy full reprocess
        }
    } else {
        personalizationFilter = `AND (c.personalization_first_line IS NULL OR BTRIM(c.personalization_first_line) = '')`;
    }
    const emailStatusFilter = requireValidEmail
        // `contacts.email_status` is normalized to `risky` (see normalizeEmailStatus in `services/leads.js`),
        // but allow both labels defensively.
        ? `AND LOWER(TRIM(COALESCE(c.email_status, ''))) IN ('valid', 'valid-risky', 'risky')`
        : '';

    const result = await pool.query(
        `SELECT DISTINCT ON (c.id)
                c.id AS contact_id,
                co.domain_normalized AS domain,
                c.full_name AS founder_name,
                c.email,
                c.email_status,
                c.personalization_first_line
         FROM contacts c
         JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
         JOIN job_domains jd ON jd.job_id = $3 AND jd.domain_normalized = co.domain_normalized
         WHERE c.agency_id = $1 AND c.client_id = $2
           AND c.role_type = 'founder'
           AND c.email IS NOT NULL AND BTRIM(c.email) <> ''
           AND LOWER(BTRIM(COALESCE(c.full_name, ''))) <> 'not found'
           ${personalizationFilter}
           ${emailStatusFilter}
           ${COHORT_ELIGIBLE_SQL}
           ${skippedJobDomainSql()}
         ORDER BY c.id ASC
         LIMIT $4`,
        params
    );
    return result.rows;
}

/** Count finished leads for a job without materializing every row. */
export async function countFinishedLeadsForJob(jobId) {
    const result = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM contacts c
         WHERE c.job_id = $1
           AND c.role_type = 'founder'
           AND c.email IS NOT NULL AND BTRIM(c.email) <> ''
           AND c.personalization_first_line IS NOT NULL
           AND BTRIM(c.personalization_first_line) <> ''`,
        [jobId]
    );
    return result.rows[0]?.count ?? 0;
}

/**
 * Ground-truth stage column counts from processing markers (not bare column values).
 * Used at job finalize to reconcile jobs.stages with the filled "spreadsheet".
 *
 * Markers:
 * - domainPrep: job_domains.status (skipped vs processable)
 * - founders: job_domains.status done/processing + founderExcluded flag
 * - emailDiscovery: contacts.email_find_completed_at (or CSV import when skipped)
 * - verification: contacts.email_verify_completed_at
 * - personalization: contacts.job_id + personalization_first_line for this run
 */
export async function countJobStageStats(agencyId, clientId, jobId, options = {}) {
    const {
        skipFounderFinder = false,
        skipEmailFinder = false,
        skipVerification = false,
        personalizeFirstLine = false,
        domainCheckSkipped = false,
        // Count only completions stamped at/after this run started, so reprocess runs
        // don't show prior-run emails/verifications/personalizations as this run's work.
        // Null = legacy behaviour (count any completion). See getEmailQueue/getVerifyQueue
        // which already scope eligibility by the same boundary (jobs.created_at).
        runStartedAt = null
    } = options;

    const domainCounts = await countJobDomainsByStatus(jobId);
    const domainTotal = domainCounts.pending + domainCounts.processing + domainCounts.done + domainCounts.skipped;

    const foundersResult = await pool.query(
        `SELECT
            COUNT(*) FILTER (
                WHERE jd.status IN ('done', 'processing')
            )::int AS processed,
            COUNT(*) FILTER (
                WHERE COALESCE(jd.raw_row->'_enrichment'->>'founderExcluded', 'false') = 'true'
            )::int AS excluded
         FROM job_domains jd
         WHERE jd.job_id = $1
           AND jd.status <> 'skipped'`,
        [jobId]
    );

    const foundersFoundResult = await pool.query(
        `SELECT COUNT(DISTINCT jd.domain_normalized)::int AS found
         FROM job_domains jd
         JOIN companies co ON co.domain_normalized = jd.domain_normalized
             AND co.client_id = $2 AND co.agency_id = $1
         JOIN contacts c ON c.company_id = co.id
             AND c.role_type = 'founder' AND c.agency_id = $1
         WHERE jd.job_id = $3
           AND jd.status IN ('done', 'processing')
           AND jd.status <> 'skipped'
           AND COALESCE(jd.raw_row->'_enrichment'->>'founderExcluded', 'false') <> 'true'
           AND c.full_name IS NOT NULL AND BTRIM(c.full_name) <> ''
           AND LOWER(BTRIM(c.full_name)) <> 'not found'`,
        [agencyId, clientId, jobId]
    );

    const emailSql = skipEmailFinder
        ? `SELECT
            COUNT(DISTINCT c.id)::int AS processed,
            COUNT(DISTINCT c.id) FILTER (
                WHERE c.email IS NOT NULL AND BTRIM(c.email) <> ''
            )::int AS found,
            0::int AS not_found,
            0::int AS errors
           ${EMAIL_DISCOVERY_COHORT_SQL}`
        : `SELECT
            COUNT(DISTINCT c.id) FILTER (
                WHERE c.email_find_completed_at IS NOT NULL
                  AND ($4::timestamptz IS NULL OR c.email_find_completed_at >= $4::timestamptz)
            )::int AS processed,
            COUNT(DISTINCT c.id) FILTER (
                WHERE c.email_find_completed_at IS NOT NULL
                  AND ($4::timestamptz IS NULL OR c.email_find_completed_at >= $4::timestamptz)
                  AND c.email IS NOT NULL AND BTRIM(c.email) <> ''
            )::int AS found,
            COUNT(DISTINCT c.id) FILTER (
                WHERE c.email_find_completed_at IS NOT NULL
                  AND ($4::timestamptz IS NULL OR c.email_find_completed_at >= $4::timestamptz)
                  AND (c.email IS NULL OR BTRIM(c.email) = '')
            )::int AS not_found,
            0::int AS errors
           ${EMAIL_DISCOVERY_COHORT_SQL}`;

    const emailResult = await pool.query(
        emailSql,
        skipEmailFinder ? [agencyId, clientId, jobId] : [agencyId, clientId, jobId, runStartedAt]
    );

    const verificationSql = skipVerification
        ? `SELECT 0::int AS verified, 0::int AS valid, 0::int AS invalid, 0::int AS unknown, 0::int AS valid_risky`
        : `SELECT
            COUNT(DISTINCT c.id) FILTER (
                WHERE c.email_verify_completed_at IS NOT NULL
                  AND ($4::timestamptz IS NULL OR c.email_verify_completed_at >= $4::timestamptz)
            )::int AS verified,
            COUNT(DISTINCT c.id) FILTER (
                WHERE c.email_verify_completed_at IS NOT NULL
                  AND ($4::timestamptz IS NULL OR c.email_verify_completed_at >= $4::timestamptz)
                  AND LOWER(TRIM(COALESCE(c.email_status, ''))) = 'valid'
            )::int AS valid,
            COUNT(DISTINCT c.id) FILTER (
                WHERE c.email_verify_completed_at IS NOT NULL
                  AND ($4::timestamptz IS NULL OR c.email_verify_completed_at >= $4::timestamptz)
                  AND LOWER(TRIM(COALESCE(c.email_status, ''))) = 'invalid'
            )::int AS invalid,
            COUNT(DISTINCT c.id) FILTER (
                WHERE c.email_verify_completed_at IS NOT NULL
                  AND ($4::timestamptz IS NULL OR c.email_verify_completed_at >= $4::timestamptz)
                  AND LOWER(TRIM(COALESCE(c.email_status, ''))) = 'unknown'
            )::int AS unknown,
            COUNT(DISTINCT c.id) FILTER (
                WHERE c.email_verify_completed_at IS NOT NULL
                  AND ($4::timestamptz IS NULL OR c.email_verify_completed_at >= $4::timestamptz)
                  AND LOWER(TRIM(COALESCE(c.email_status, ''))) IN ('valid-risky', 'risky')
            )::int AS valid_risky
           FROM contacts c
           JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
           JOIN job_domains jd ON jd.job_id = $3 AND jd.domain_normalized = co.domain_normalized
           WHERE c.agency_id = $1 AND c.client_id = $2
             AND c.role_type = 'founder'
             AND c.email IS NOT NULL AND BTRIM(c.email) <> ''
             AND LOWER(BTRIM(COALESCE(c.full_name, ''))) <> 'not found'
             ${COHORT_ELIGIBLE_SQL}
             ${skippedJobDomainSql()}`;

    const verificationResult = skipVerification
        ? { rows: [{ verified: 0, valid: 0, invalid: 0, unknown: 0, valid_risky: 0 }] }
        : await pool.query(verificationSql, [agencyId, clientId, jobId, runStartedAt]);

    const personalizationResult = !personalizeFirstLine
        ? { rows: [{ processed: 0, personalized: 0 }] }
        : await pool.query(
            `SELECT
                COUNT(DISTINCT c.id) FILTER (
                    WHERE c.personalization_completed_at IS NOT NULL
                      AND ($4::timestamptz IS NULL OR c.personalization_completed_at >= $4::timestamptz)
                      AND c.personalization_first_line IS NOT NULL
                      AND BTRIM(c.personalization_first_line) <> ''
                )::int AS processed,
                COUNT(DISTINCT c.id) FILTER (
                    WHERE c.personalization_completed_at IS NOT NULL
                      AND ($4::timestamptz IS NULL OR c.personalization_completed_at >= $4::timestamptz)
                      AND c.personalization_first_line IS NOT NULL
                      AND BTRIM(c.personalization_first_line) <> ''
                      AND c.personalization_first_line NOT IN ('[Generation failed]', 'invalid')
                )::int AS personalized
             FROM contacts c
             JOIN companies co ON co.id = c.company_id AND co.agency_id = $1
             JOIN job_domains jd ON jd.job_id = $3 AND jd.domain_normalized = co.domain_normalized
             WHERE c.agency_id = $1 AND c.client_id = $2
               AND c.role_type = 'founder'
               AND c.email IS NOT NULL AND BTRIM(c.email) <> ''
               AND LOWER(BTRIM(COALESCE(c.full_name, ''))) <> 'not found'
               ${COHORT_ELIGIBLE_SQL}
               ${skippedJobDomainSql()}`,
            [agencyId, clientId, jobId, runStartedAt]
        );

    const foundersRow = foundersResult.rows[0] || {};
    const emailRow = emailResult.rows[0] || {};
    const verifyRow = verificationResult.rows[0] || {};
    const personalizeRow = personalizationResult.rows[0] || {};

    const processable = domainCounts.pending + domainCounts.processing + domainCounts.done;

    return {
        domainPrep: {
            checked: domainCheckSkipped ? 0 : domainTotal,
            processable,
            skipped: domainCounts.skipped,
            domainCheckSkipped: !!domainCheckSkipped
        },
        founders: {
            processed: Number(foundersRow.processed ?? 0),
            excluded: Number(foundersRow.excluded ?? 0),
            found: Number(foundersFoundResult.rows[0]?.found ?? 0),
            skipped: !!skipFounderFinder
        },
        emailDiscovery: {
            processed: Number(emailRow.processed ?? 0),
            found: Number(emailRow.found ?? 0),
            notFound: Number(emailRow.not_found ?? 0),
            errors: Number(emailRow.errors ?? 0),
            skipped: !!skipEmailFinder
        },
        verification: {
            verified: Number(verifyRow.verified ?? 0),
            valid: Number(verifyRow.valid ?? 0),
            invalid: Number(verifyRow.invalid ?? 0),
            unknown: Number(verifyRow.unknown ?? 0),
            validRisky: Number(verifyRow.valid_risky ?? 0),
            skipped: !!skipVerification
        },
        personalization: {
            processed: Number(personalizeRow.processed ?? 0),
            personalized: Number(personalizeRow.personalized ?? 0),
            skipped: !personalizeFirstLine
        }
    };
}

function isValidUploadEmailStatus(status) {
    return String(status || '').toLowerCase().trim() === 'valid';
}

function isRiskyUploadEmailStatus(status) {
    const normalized = String(status || '').toLowerCase().trim();
    return normalized === 'risky' || normalized === 'valid-risky';
}

export function filterUnifiedRowsByEmailStatus(rows, { includeValid = true, includeRisky = true } = {}) {
    return rows.filter((row) => {
        if (includeValid && isValidUploadEmailStatus(row.email_status)) return true;
        if (includeRisky && isRiskyUploadEmailStatus(row.email_status)) return true;
        return false;
    });
}

export function countUnifiedRowsByEmailStatus(rows) {
    return rows.reduce((counts, row) => {
        if (isValidUploadEmailStatus(row.email_status)) {
            counts.valid += 1;
        } else if (isRiskyUploadEmailStatus(row.email_status)) {
            counts.risky += 1;
        }
        return counts;
    }, { valid: 0, risky: 0 });
}

function buildUploadEmailStatusFilter({ includeValid = true, includeRisky = true } = {}) {
    const statuses = [];
    if (includeValid) statuses.push('valid');
    if (includeRisky) statuses.push('risky', 'valid-risky');
    if (statuses.length === 0) return 'AND FALSE';
    return `AND LOWER(TRIM(COALESCE(c.email_status, ''))) IN (${statuses.map((status) => `'${status}'`).join(', ')})`;
}

function buildUnifiedScopeFilter(scope, options = {}) {
    if (scope === 'valid') {
        return buildUploadEmailStatusFilter(options);
    }
    if (scope === 'complete') {
        return `AND c.email IS NOT NULL AND BTRIM(c.email) <> ''
            AND c.personalization_first_line IS NOT NULL AND BTRIM(c.personalization_first_line) <> ''`;
    }
    return '';
}

export const STANDARD_UNIFIED_HEADERS = [
    'domain',
    'founder_name',
    'email',
    'email_status',
    'first_name',
    'last_name',
    'personalization'
];

export const SHOPPING_AUDIT_UNIFIED_HEADERS = [
    'domain',
    'founder_name',
    'email',
    'email_status',
    'first_name',
    'last_name',
    'shopify_store',
    'ad_matched',
    'hero_product',
    'shopping_ad_link',
    'signal',
    'issue',
    'product_short',
    'ad_price',
    'page_price',
    'other_signals',
    'personalization'
];

const UNIFIED_ROW_BASE_SELECT = `
        co.domain_normalized AS domain,
        c.full_name AS founder_name,
        c.email,
        c.email_status,
        c.personalization_first_line AS personalization,
        c.personalization_first_line AS first_line`;

const SHOPPING_AUDIT_ROW_JOINS = `
    LEFT JOIN hero_selections hs
        ON hs.job_id = c.job_id AND hs.domain_normalized = co.domain_normalized
    LEFT JOIN shopify_snapshots hero_snap
        ON hero_snap.id = hs.shopify_snapshot_id
    LEFT JOIN signal_emissions se
        ON se.job_id = c.job_id AND se.domain_normalized = co.domain_normalized
    LEFT JOIN LATERAL (
        SELECT ao.matched, ao.matched_card, ao.matched_product
        FROM ad_observations ao
        WHERE ao.job_id = c.job_id
          AND ao.domain_normalized = co.domain_normalized
        ORDER BY
            ao.matched DESC,
            CASE ao.branch WHEN 'clean' THEN 0 WHEN 'ambiguous' THEN 1 ELSE 2 END,
            ao.observed_at DESC NULLS LAST
        LIMIT 1
    ) ad ON true`;

const UNIFIED_ROW_FROM_BASE = `
    FROM contacts c
    JOIN companies co ON co.id = c.company_id`;

const UNIFIED_ROW_WHERE = `
    WHERE c.job_id = $1 AND c.role_type = 'founder'`;

const INVALID_FOUNDER_NAMES_SQL = `'not found', 'n/a', 'unknown'`;

function buildCompletenessOrderBy(shoppingAudit) {
    const adLinkScore = shoppingAudit
        ? `CASE WHEN ad.matched THEN 10000 ELSE 0 END + `
        : '';
    const founderScore = `CASE WHEN c.full_name IS NOT NULL AND BTRIM(c.full_name) <> ''
        AND LOWER(BTRIM(c.full_name)) NOT IN (${INVALID_FOUNDER_NAMES_SQL}) THEN 1000 ELSE 0 END`;
    const emailScore = `CASE WHEN c.email IS NOT NULL AND BTRIM(c.email) <> '' AND c.email LIKE '%@%'
        AND LOWER(TRIM(COALESCE(c.email_status, ''))) = 'valid' THEN 100 ELSE 0 END`;
    const personalizationScore = `CASE WHEN c.personalization_first_line IS NOT NULL AND BTRIM(c.personalization_first_line) <> ''
        AND LOWER(BTRIM(c.personalization_first_line)) <> 'invalid' THEN 10 ELSE 0 END`;

    return `ORDER BY (${adLinkScore}${founderScore} + ${emailScore} + ${personalizationScore}) DESC, co.domain_normalized ASC`;
}

function buildUnifiedOrderBy(shoppingAudit, { sortByCompleteness = false } = {}) {
    if (sortByCompleteness) {
        return buildCompletenessOrderBy(shoppingAudit);
    }
    return 'ORDER BY co.domain_normalized ASC';
}

function buildUnifiedQueryParts(shoppingAudit) {
    if (!shoppingAudit) {
        return {
            select: `SELECT ${UNIFIED_ROW_BASE_SELECT}`,
            from: `${UNIFIED_ROW_FROM_BASE}${UNIFIED_ROW_WHERE}`
        };
    }

    return {
        select: `SELECT
        ${UNIFIED_ROW_BASE_SELECT},
        CASE
            WHEN hs.id IS NOT NULL THEN 'Yes'
            WHEN EXISTS (
                SELECT 1 FROM shopify_snapshots ss
                WHERE ss.job_id = c.job_id AND ss.domain_normalized = co.domain_normalized
                LIMIT 1
            ) THEN 'Yes'
            ELSE 'No'
        END AS shopify_store,
        CASE WHEN COALESCE(ad.matched, FALSE) THEN 'Yes' ELSE 'No' END AS ad_matched,
        COALESCE(NULLIF(ad.matched_product->>'title', ''), hero_snap.title, '') AS hero_product,
        COALESCE(ad.matched_card->>'link', '') AS shopping_ad_link,
        se.signal_type,
        se.observed AS signal_observed,
        se.expected AS signal_expected,
        se.export_vars AS signal_export_vars,
        se.secondary_signals AS signal_secondary`,
        from: `${UNIFIED_ROW_FROM_BASE}
    ${SHOPPING_AUDIT_ROW_JOINS}${UNIFIED_ROW_WHERE}`
    };
}

export function shoppingAuditFromJobRow(row) {
    if (!row) return false;
    return resolvePipelineMode(row.options || {}, row.stages || {}) === 'shopping_audit';
}

export async function isShoppingAuditJobById(jobId) {
    const result = await pool.query(
        `SELECT options, stages FROM jobs WHERE id = $1`,
        [jobId]
    );
    const row = result.rows[0];
    if (!row) return false;
    return resolvePipelineMode(row.options || {}, row.stages || {}) === 'shopping_audit';
}

export function getUnifiedRowHeaders(shoppingAudit = false) {
    return shoppingAudit ? SHOPPING_AUDIT_UNIFIED_HEADERS : STANDARD_UNIFIED_HEADERS;
}

function mapUnifiedContactRow(row, shoppingAudit = false) {
    const parts = String(row.founder_name || '').trim().split(/\s+/);
    const firstName = parts[0] || '';
    const lastName = parts.length > 1 ? parts.slice(1).join(' ') : '';
    const base = {
        domain: row.domain,
        founder_name: row.founder_name || '',
        email: row.email || '',
        email_status: row.email_status || '',
        first_name: firstName,
        last_name: lastName,
        personalization: row.personalization || row.first_line || ''
    };
    if (!shoppingAudit) return base;

    // Cold-email variables. export_vars is authoritative; rows emitted before the
    // export_vars column existed fall back to deriving from the raw signal fields.
    const exportVars = row.signal_export_vars || {};
    const observed = row.signal_observed || {};
    const expected = row.signal_expected || {};
    const signalType = row.signal_type || '';
    const secondary = Array.isArray(row.signal_secondary) ? row.signal_secondary : [];

    return {
        ...base,
        shopify_store: row.shopify_store || 'No',
        ad_matched: row.ad_matched || 'No',
        hero_product: row.hero_product || '',
        shopping_ad_link: row.shopping_ad_link || '',
        signal: signalType,
        issue: exportVars.issue ?? (SIGNAL_ISSUE_LABELS[signalType] || ''),
        product_short: exportVars.product_short || '',
        ad_price: exportVars.ad_price || formatPriceUsd(observed.ad_price),
        page_price: exportVars.page_price || formatPriceUsd(expected.page_price),
        other_signals: secondary.map((s) => s?.signal_type).filter(Boolean).join('; ')
    };
}

async function resolveShoppingAuditFlag(jobId, options = {}) {
    if (typeof options.shoppingAudit === 'boolean') {
        return options.shoppingAudit;
    }
    return isShoppingAuditJobById(jobId);
}

export async function buildUnifiedRowsFromDb(jobId, scope = 'valid', options = {}) {
    const shoppingAudit = await resolveShoppingAuditFlag(jobId, options);
    const { select, from } = buildUnifiedQueryParts(shoppingAudit);
    const statusFilter = buildUnifiedScopeFilter(scope, options);
    const result = await pool.query(
        `${select}
         ${from}
         ${statusFilter}
         ORDER BY co.domain_normalized ASC`,
        [jobId]
    );

    return result.rows.map((row) => mapUnifiedContactRow(row, shoppingAudit));
}

export async function listUnifiedRowsFromDb(jobId, {
    scope = 'all',
    limit = 100,
    offset = 0,
    sortByCompleteness = false,
    ...options
} = {}) {
    const shoppingAudit = await resolveShoppingAuditFlag(jobId, options);
    const { select, from } = buildUnifiedQueryParts(shoppingAudit);
    const statusFilter = buildUnifiedScopeFilter(scope, options);
    const orderBy = buildUnifiedOrderBy(shoppingAudit, { sortByCompleteness });
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const result = await pool.query(
        `${select},
         COUNT(*) OVER()::int AS _total_count
         ${from}
         ${statusFilter}
         ${orderBy}
         LIMIT $2 OFFSET $3`,
        [jobId, parsedLimit, parsedOffset]
    );

    const total = result.rows[0]?._total_count ?? 0;
    const rows = result.rows.map((row) => {
        const { _total_count: _ignored, ...dataRow } = row;
        return mapUnifiedContactRow(dataRow, shoppingAudit);
    });
    return {
        rows,
        total,
        limit: parsedLimit,
        offset: parsedOffset,
        hasMore: parsedOffset + rows.length < total,
        shoppingAudit,
        headers: getUnifiedRowHeaders(shoppingAudit)
    };
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
