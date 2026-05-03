-- 0018_lead_search_indexes.sql
-- Indexes that align the contacts/companies tables with how the All Leads
-- tab in the client page actually queries data:
--   1. The unfiltered list paginates by (agency_id, client_id) ORDER BY created_at DESC.
--   2. Email searches need to be case-insensitive (~5% of rows have mixed case).
--   3. The dynamic-filter UI uses `contains` operators that compile to
--      LOWER(col) LIKE '%token%', which has no index support today.

BEGIN;

-- 1. Walk the latest contacts for a single client without filter-then-sort.
CREATE INDEX IF NOT EXISTS idx_contacts_agency_client_created_at
    ON contacts (agency_id, client_id, created_at DESC);

-- 2. Case-insensitive email lookups for the search bar.
--    The existing contacts_client_email_unique is case-sensitive on `email`.
CREATE INDEX IF NOT EXISTS idx_contacts_client_email_lower
    ON contacts (client_id, LOWER(email))
    WHERE email IS NOT NULL;

-- 3. Trigram support for `contains` filters on free-text columns.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_contacts_full_name_trgm
    ON contacts USING gin (LOWER(full_name) gin_trgm_ops)
    WHERE full_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_email_trgm
    ON contacts USING gin (LOWER(email) gin_trgm_ops)
    WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_domain_normalized_trgm
    ON companies USING gin (domain_normalized gin_trgm_ops)
    WHERE domain_normalized IS NOT NULL;

COMMIT;
