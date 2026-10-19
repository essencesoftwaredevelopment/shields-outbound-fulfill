/**
 * Lookups for an uploaded domain list.
 *
 * A single `domain_normalized = ANY($2)` over tens of thousands of values, plus
 * correlated EXISTS probes into contacts, made Postgres scan far more than the
 * uploaded set. On a 20k–50k CSV that ran past the proxy timeout (504) while
 * the upload modal was still on "Checking domains…".
 *
 * Drive each chunk from `unnest` and resolve the company with a lateral index
 * lookup on (client_id, domain_normalized) so the plan stays a few index probes
 * per domain instead of a client-wide scan.
 */

export const DOMAIN_LOOKUP_CHUNK = 1000;

export function chunkList(items, size = DOMAIN_LOOKUP_CHUNK) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const step = Math.max(1, Math.floor(size) || DOMAIN_LOOKUP_CHUNK);
    const chunks = [];
    for (let i = 0; i < items.length; i += step) {
        chunks.push(items.slice(i, i + step));
    }
    return chunks;
}

/**
 * One row per distinct uploaded domain that already belongs to the client.
 * `$3` is only referenced when `reaudit` is set (months as text).
 */
export function existingDomainsSql({ reaudit = false } = {}) {
    const auditPredicate = reaudit
        ? `
       AND c.last_audit_at IS NOT NULL
       AND c.last_audit_at > NOW() - ($3::text || ' months')::interval`
        : '';
    return `
        SELECT co.domain_normalized
        FROM (SELECT DISTINCT domain FROM unnest($2::text[]) AS input(domain)) input
        JOIN LATERAL (
            SELECT c.domain_normalized
            FROM companies c
            WHERE c.client_id = $1
              AND c.domain_normalized = input.domain
              ${auditPredicate}
            LIMIT 1
        ) co ON true`;
}

/**
 * Same counts as the upload modal: distinct existing domains, and how many of
 * those have a job, a founder name, an email, or a first line.
 * Input duplicates are collapsed so chunked callers can sum the rows.
 */
export const DOMAIN_ENRICHMENT_SQL = `
    SELECT
        COUNT(*)::int AS existing,
        COUNT(*) FILTER (WHERE COALESCE(stats.ran, false))::int AS run_count,
        COUNT(*) FILTER (WHERE COALESCE(stats.has_founder, false))::int AS with_founders_count,
        COUNT(*) FILTER (WHERE COALESCE(stats.has_email, false))::int AS with_emails_count,
        COUNT(*) FILTER (WHERE COALESCE(stats.has_personalization, false))::int AS with_personalization_count
    FROM (SELECT DISTINCT domain FROM unnest($2::text[]) AS input(domain)) input
    JOIN LATERAL (
        SELECT c.id
        FROM companies c
        WHERE c.client_id = $1
          AND c.domain_normalized = input.domain
        LIMIT 1
    ) co ON true
    LEFT JOIN LATERAL (
        SELECT
            bool_or(ct.job_id IS NOT NULL) AS ran,
            bool_or(
                ct.job_id IS NOT NULL
                AND ct.full_name IS NOT NULL
                AND ct.full_name <> ''
            ) AS has_founder,
            bool_or(
                ct.job_id IS NOT NULL
                AND ct.email IS NOT NULL
                AND ct.email <> ''
            ) AS has_email,
            bool_or(
                ct.job_id IS NOT NULL
                AND ct.personalization_first_line IS NOT NULL
                AND ct.personalization_first_line <> ''
            ) AS has_personalization
        FROM contacts ct
        WHERE ct.company_id = co.id
    ) stats ON true`;

export function emptyDomainStats() {
    return {
        existing: 0,
        run: 0,
        withFounders: 0,
        withEmails: 0,
        withPersonalization: 0
    };
}

export function addDomainStats(totals, row) {
    totals.existing += Number(row?.existing) || 0;
    totals.run += Number(row?.run_count) || 0;
    totals.withFounders += Number(row?.with_founders_count) || 0;
    totals.withEmails += Number(row?.with_emails_count) || 0;
    totals.withPersonalization += Number(row?.with_personalization_count) || 0;
    return totals;
}

export async function summarizeDomains(query, clientId, uniqueDomains) {
    const totals = emptyDomainStats();
    for (const chunk of chunkList(uniqueDomains)) {
        const result = await query(DOMAIN_ENRICHMENT_SQL, [clientId, chunk]);
        addDomainStats(totals, result.rows?.[0]);
    }
    return totals;
}

export async function collectExistingDomains(query, clientId, uniqueDomains, { reauditMonths = null } = {}) {
    const months = Number(reauditMonths);
    const reaudit = Number.isFinite(months) && months > 0;
    const sql = existingDomainsSql({ reaudit });
    const existing = new Set();
    for (const chunk of chunkList(uniqueDomains)) {
        const params = reaudit ? [clientId, chunk, String(months)] : [clientId, chunk];
        const result = await query(sql, params);
        for (const row of result.rows || []) {
            if (row?.domain_normalized) existing.add(row.domain_normalized);
        }
    }
    return existing;
}
