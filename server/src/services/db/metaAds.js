import { pool } from '../../config/db.js';

/**
 * Job domains in this batch that still need a Meta ad count this job:
 * not dedupe/DNS/gate-skipped and not already counted by an earlier attempt.
 */
export async function listMetaAdsWork(jobId, domains) {
    if (!domains?.length) return [];
    const result = await pool.query(
        `SELECT jd.domain_normalized
           FROM unnest($2::text[]) AS batch(domain_normalized)
           JOIN job_domains jd ON jd.job_id = $1 AND jd.domain_normalized = batch.domain_normalized
          WHERE jd.status <> 'skipped'
            AND jd.meta_ads_status IS NULL`,
        [jobId, domains]
    );
    return result.rows.map((r) => r.domain_normalized);
}

/** domain → { active_ads, checked_at, error } for the agency. */
export async function loadDomainMetaAds(agencyId, domains) {
    const map = new Map();
    if (!domains?.length) return map;
    const result = await pool.query(
        `SELECT domain_normalized, active_ads, checked_at, error
           FROM domain_meta_ads
          WHERE agency_id = $1 AND domain_normalized = ANY($2::text[])`,
        [agencyId, domains]
    );
    for (const row of result.rows) map.set(row.domain_normalized, row);
    return map;
}

/**
 * Save results and mark the job's domains in one transaction-free pass
 * (both writes are idempotent).
 *
 * @param {{ agencyId: string, jobId: string, results: Array<{
 *   domain: string, status: 'counted' | 'reused' | 'error',
 *   activeAds?: number | null, error?: string | null }> }} args
 */
export async function saveMetaAdsResults({ agencyId, jobId, results }) {
    if (!results?.length) return;
    const fresh = results.filter((r) => r.status === 'counted' || r.status === 'error');
    if (fresh.length) {
        await pool.query(
            `INSERT INTO domain_meta_ads AS d (agency_id, domain_normalized, active_ads, checked_at, error, updated_at)
             SELECT $1, r.domain, r.active_ads,
                    CASE WHEN r.error IS NULL THEN NOW() END,
                    r.error, NOW()
               FROM unnest($2::text[], $3::int[], $4::text[]) AS r(domain, active_ads, error)
             ON CONFLICT (agency_id, domain_normalized) DO UPDATE SET
                -- A failed attempt keeps the last good count and when it was taken.
                active_ads = CASE WHEN EXCLUDED.error IS NULL THEN EXCLUDED.active_ads ELSE d.active_ads END,
                checked_at = CASE WHEN EXCLUDED.error IS NULL THEN EXCLUDED.checked_at ELSE d.checked_at END,
                error = EXCLUDED.error,
                updated_at = NOW()`,
            [
                agencyId,
                fresh.map((r) => r.domain),
                fresh.map((r) => (r.status === 'counted' ? r.activeAds : null)),
                fresh.map((r) => (r.status === 'error' ? String(r.error || 'error').slice(0, 500) : null))
            ]
        );
    }
    await pool.query(
        `UPDATE job_domains jd
            SET meta_ads_status = r.status, updated_at = NOW()
           FROM unnest($2::text[], $3::text[]) AS r(domain, status)
          WHERE jd.job_id = $1 AND jd.domain_normalized = r.domain`,
        [jobId, results.map((r) => r.domain), results.map((r) => r.status)]
    );
}

/**
 * Gate: batch domains whose count this job is below `minActiveAds` skip founder
 * lookup and every later stage. Same mechanism as the shopping-audit
 * matched-only gate (status 'skipped'), plus a flag recording why. Domains
 * whose count failed are never gated. Reads the stored counts, so a retried
 * step still gates domains counted by an earlier attempt.
 *
 * @returns {Promise<number>} domains newly gated
 */
export async function gateJobDomainsBelowMinAds({ agencyId, jobId, domains, minActiveAds }) {
    if (!domains?.length || !(minActiveAds > 0)) return 0;
    const result = await pool.query(
        `UPDATE job_domains jd
            SET status = 'skipped',
                raw_row = jsonb_set(COALESCE(jd.raw_row, '{}'::jsonb), '{_enrichment,metaAdsGated}', 'true'::jsonb, true),
                updated_at = NOW()
           FROM domain_meta_ads d
          WHERE jd.job_id = $2
            AND jd.domain_normalized = ANY($3::text[])
            AND jd.status IN ('pending', 'processing')
            AND jd.meta_ads_status IN ('counted', 'reused')
            AND d.agency_id = $1
            AND d.domain_normalized = jd.domain_normalized
            AND d.active_ads IS NOT NULL
            AND d.active_ads < $4`,
        [agencyId, jobId, domains, minActiveAds]
    );
    return result.rowCount || 0;
}

/** Ads-only runs: finish the batch's domains without touching any lead. */
export async function markMetaAdsOnlyDomainsDone(jobId, domains) {
    if (!domains?.length) return;
    await pool.query(
        `UPDATE job_domains SET status = 'done', updated_at = NOW()
          WHERE job_id = $1 AND domain_normalized = ANY($2::text[])
            AND status IN ('pending', 'processing')`,
        [jobId, domains]
    );
}

/** Atomic tally on jobs.options.metaAdsStats (read by the Pipeline card via Realtime). */
export async function incrementMetaAdsStats(jobId, agencyId, delta) {
    const keys = ['counted', 'reused', 'withAds', 'errors', 'gated', 'credits'];
    const values = keys.map((k) => Math.max(0, Math.round(Number(delta?.[k]) || 0)));
    if (!values.some((v) => v > 0) && !delta?.lastError) return;
    await pool.query(
        `UPDATE jobs SET options = jsonb_set(
                COALESCE(options, '{}'::jsonb),
                '{metaAdsStats}',
                jsonb_build_object(
                    'counted', COALESCE((options->'metaAdsStats'->>'counted')::int, 0) + $3,
                    'reused', COALESCE((options->'metaAdsStats'->>'reused')::int, 0) + $4,
                    'withAds', COALESCE((options->'metaAdsStats'->>'withAds')::int, 0) + $5,
                    'errors', COALESCE((options->'metaAdsStats'->>'errors')::int, 0) + $6,
                    'gated', COALESCE((options->'metaAdsStats'->>'gated')::int, 0) + $7,
                    'credits', COALESCE((options->'metaAdsStats'->>'credits')::numeric, 0) + $8,
                    'lastError', COALESCE($9, options->'metaAdsStats'->>'lastError')
                ),
                true
            ),
            updated_at = NOW()
          WHERE id = $1 AND agency_id = $2`,
        [jobId, agencyId, ...values, delta?.lastError ? String(delta.lastError).slice(0, 300) : null]
    );
}
