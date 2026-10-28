-- Partial index for the All Leads "Email is not empty" filter
-- (leads.js: `c.email IS NOT NULL AND BTRIM(c.email) <> ''`), ordered like the
-- table view (created_at DESC, id DESC). Only ~10% of ESSENCE Retention's 1.24M
-- contacts have an email, so without it a filtered page walked
-- idx_contacts_agency_client_created_at and discarded ~850k rows (8.0s → 1.3s cold).
--
-- Applied to prod 2026-10-28. CONCURRENTLY cannot run inside a transaction:
-- run this file as a single statement, not wrapped in BEGIN/COMMIT.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_agency_client_created_with_email
    ON contacts (agency_id, client_id, created_at DESC, id DESC)
    WHERE email IS NOT NULL AND btrim(email) <> '';
