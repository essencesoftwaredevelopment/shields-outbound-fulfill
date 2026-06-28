-- =============================================================================
-- Founder discovery timestamp — batched backfill for Supabase SQL editor
-- =============================================================================
--
-- Run each section in order. Re-run batch steps until they report UPDATE 0.
-- Safe to re-run: every step is idempotent (only fills NULL founder_find_completed_at).
--
-- Progress check (run anytime):
--   SELECT
--     COUNT(*) FILTER (WHERE founder_find_completed_at IS NOT NULL) AS completed,
--     COUNT(*) FILTER (WHERE founder_find_completed_at IS NULL)     AS remaining,
--     COUNT(*)                                                        AS total
--   FROM contacts;
--
-- =============================================================================


-- ── 0. Schema (run once) ─────────────────────────────────────────────────────
-- Column may already exist from a partial run — IF NOT EXISTS is safe.

ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS founder_find_completed_at TIMESTAMPTZ;


-- ── 1. Found: contacts with a usable founder name ────────────────────────────
-- Re-run until UPDATE 0. Adjust LIMIT if you hit statement timeout (try 5000).

UPDATE contacts
SET founder_find_completed_at = COALESCE(founder_find_completed_at, updated_at)
WHERE id IN (
    SELECT id
    FROM contacts
    WHERE founder_find_completed_at IS NULL
      AND full_name IS NOT NULL
      AND BTRIM(full_name) <> ''
      AND LOWER(BTRIM(full_name)) <> 'not found'
      AND LOWER(BTRIM(full_name)) <> 'not_found'
    ORDER BY id
    LIMIT 10000
);


-- ── 1b. Legacy not-found names (full_name = "Not Found" before timestamps existed) ─
-- Re-run until UPDATE 0. ~28k rows; uses updated_at as completion time.

UPDATE contacts
SET founder_find_completed_at = COALESCE(founder_find_completed_at, updated_at)
WHERE id IN (
    SELECT id
    FROM contacts
    WHERE founder_find_completed_at IS NULL
      AND full_name IS NOT NULL
      AND BTRIM(full_name) <> ''
      AND (
          LOWER(BTRIM(full_name)) = 'not found'
          OR LOWER(BTRIM(full_name)) = 'not_found'
          OR LOWER(BTRIM(full_name)) LIKE '%not found%'
      )
    ORDER BY id
    LIMIT 10000
);


-- ── 2. Not found (CSV / legacy): job_domains with founderExcluded ────────────
-- Re-run until UPDATE 0.

UPDATE contacts c
SET founder_find_completed_at = COALESCE(c.founder_find_completed_at, jd.updated_at)
FROM companies co
JOIN job_domains jd ON jd.domain_normalized = co.domain_normalized
WHERE c.id IN (
    SELECT c2.id
    FROM contacts c2
    JOIN companies co2 ON co2.id = c2.company_id
    JOIN job_domains jd2
      ON jd2.domain_normalized = co2.domain_normalized
     AND jd2.job_id = c2.job_id
    WHERE c2.role_type = 'founder'
      AND c2.founder_find_completed_at IS NULL
      AND COALESCE(jd2.raw_row->'_enrichment'->>'founderExcluded', 'false') = 'true'
    ORDER BY c2.id
    LIMIT 10000
)
AND c.company_id = co.id
AND c.role_type = 'founder'
AND c.job_id = jd.job_id
AND COALESCE(jd.raw_row->'_enrichment'->>'founderExcluded', 'false') = 'true';


-- ── 3. Not found (founder-finder): Serper ran but no valid name ──────────────
-- Covers cases like leatherick.com (searched, blank founder name).
-- ~3,840 rows were backfilled in an earlier run; re-run until UPDATE 0.

UPDATE contacts c
SET founder_find_completed_at = COALESCE(c.founder_find_completed_at, jsc.updated_at)
FROM companies co
JOIN job_serper_cache jsc ON jsc.domain_normalized = co.domain_normalized
WHERE c.id IN (
    SELECT c2.id
    FROM contacts c2
    JOIN companies co2 ON co2.id = c2.company_id
    JOIN job_serper_cache jsc2
      ON jsc2.domain_normalized = co2.domain_normalized
     AND jsc2.job_id = c2.job_id
    WHERE c2.role_type = 'founder'
      AND c2.founder_find_completed_at IS NULL
      AND (
          c2.full_name IS NULL
          OR BTRIM(c2.full_name) = ''
          OR LOWER(BTRIM(c2.full_name)) IN ('not found', 'not_found')
      )
    ORDER BY c2.id
    LIMIT 10000
)
AND c.company_id = co.id
AND c.role_type = 'founder'
AND c.job_id = jsc.job_id
AND (
    c.full_name IS NULL
    OR BTRIM(c.full_name) = ''
    OR LOWER(BTRIM(c.full_name)) IN ('not found', 'not_found')
);


-- ── 4. Infer from email discovery (founder must have resolved first) ────────
-- Re-run until UPDATE 0.

UPDATE contacts
SET founder_find_completed_at = COALESCE(founder_find_completed_at, email_find_completed_at, updated_at)
WHERE id IN (
    SELECT id
    FROM contacts
    WHERE founder_find_completed_at IS NULL
      AND email_find_completed_at IS NOT NULL
    ORDER BY id
    LIMIT 10000
);


-- ── 5. Index (run once, after backfill) ──────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_contacts_founder_find_completed_at
    ON contacts (founder_find_completed_at)
    WHERE founder_find_completed_at IS NOT NULL;


-- ── Verification queries ─────────────────────────────────────────────────────

-- Overall progress
SELECT
    COUNT(*) FILTER (WHERE founder_find_completed_at IS NOT NULL) AS completed,
    COUNT(*) FILTER (WHERE founder_find_completed_at IS NULL)     AS remaining,
    COUNT(*)                                                        AS total
FROM contacts;

-- Spot-check a known "searched but not found" domain
SELECT co.domain_normalized, c.full_name, c.founder_find_completed_at, c.job_id
FROM contacts c
JOIN companies co ON co.id = c.company_id
WHERE co.domain_normalized = 'leatherick.com'
  AND c.job_id = '1782654648940-zezdjr';

-- Count contacts still missing timestamp but with Serper evidence
SELECT COUNT(*) AS serper_not_backfilled
FROM contacts c
JOIN companies co ON co.id = c.company_id
JOIN job_serper_cache jsc
  ON jsc.domain_normalized = co.domain_normalized
 AND jsc.job_id = c.job_id
WHERE c.role_type = 'founder'
  AND c.founder_find_completed_at IS NULL
  AND (
      c.full_name IS NULL
      OR BTRIM(c.full_name) = ''
      OR LOWER(BTRIM(c.full_name)) IN ('not found', 'not_found')
  );
