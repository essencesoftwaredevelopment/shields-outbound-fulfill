-- All Leads filters that read companies.country_code join by companies.id.
-- The companies heap is wide (store_apps, store_technologies), and a filtered
-- count probes it once per candidate. On ESSENCE Retention that was 107,191
-- primary-key lookups and 22s, to apply a country predicate that removed no
-- rows. Covering the columns that scan actually uses lets it stay index-only.
-- domain_normalized is the company column the table view selects.
--
-- "Zero times" activity filters are a correlated NOT EXISTS on
-- (contact_id, event_type) plus the tenant columns. idx_contact_instantly_events_blocker_type
-- leads with campaign_id between contact_id and event_type and does not cover
-- agency_id/client_id, so each probe walked that contact's events and fetched
-- the heap. This index seeks the event type and answers the tenant check
-- without leaving the index.
--
-- CONCURRENTLY cannot run inside a transaction: run each statement on its own,
-- not wrapped in BEGIN/COMMIT.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_companies_id_country_cover
    ON companies (id)
    INCLUDE (agency_id, client_id, country_code, domain_normalized);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_instantly_events_contact_type
    ON contact_instantly_events (contact_id, event_type)
    INCLUDE (agency_id, client_id)
    WHERE contact_id IS NOT NULL;

-- The leads table walks (agency, client) by created_at and filters
-- LOWER(COALESCE(email_status, '')) as a residual predicate. On ESSENCE
-- Retention that threw away ~70k non-valid contacts before the page filled.
-- Leading with client_id and that same expression, then created_at, lets the
-- page start at the newest matching status. company_id and agency_id are
-- included so those filters do not fetch the contact heap.
-- idx_contacts_client_email_status_lower stays: the count still bitmap-scans
-- that narrower prefix. This index is the ordered access path for the page.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_client_email_status_created
    ON contacts (client_id, (LOWER(COALESCE(email_status, ''))), created_at DESC, id DESC)
    INCLUDE (company_id, agency_id);
