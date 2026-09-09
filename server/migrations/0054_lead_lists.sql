-- 0054_lead_lists.sql
-- Named lead lists (static membership) for All Leads.
--
-- Distinct from client_segments, which store saved filters (dynamic views).
-- A list is a named collection of contacts; a contact may belong to many lists.
-- All Leads filters, enrich-filtered, and export reuse this membership the same
-- way Import Batch is reused: filter by list, then act on the matching set.

BEGIN;

CREATE TABLE IF NOT EXISTS lead_lists (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lead_lists_client_name
    ON lead_lists (client_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_lead_lists_agency_client
    ON lead_lists (agency_id, client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_lists_client
    ON lead_lists (client_id);

CREATE TABLE IF NOT EXISTS lead_list_members (
    list_id BIGINT NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
    contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (list_id, contact_id)
);

-- Reverse lookup: "which lists is this contact on?" and contact-delete cascade.
CREATE INDEX IF NOT EXISTS idx_lead_list_members_contact
    ON lead_list_members (contact_id);

ALTER TABLE lead_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_list_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_lists_agency ON lead_lists;
CREATE POLICY lead_lists_agency ON lead_lists
    FOR ALL USING (agency_id = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS lead_list_members_agency ON lead_list_members;
CREATE POLICY lead_list_members_agency ON lead_list_members
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM lead_lists ll
            WHERE ll.id = lead_list_members.list_id
              AND ll.agency_id = (SELECT auth.uid())::text
        )
    );

COMMIT;
