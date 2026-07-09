-- 0038_lead_import_batches.sql
-- No-enrichment CSV lead imports with column mapping.
--
-- lead_import_batches: one row per upload (progress, counts, mapping, collision
-- strategy). Deliberately NOT a jobs row — imports must never contend with the
-- one-active-job-per-client constraint and have no pipeline stages.
-- lead_import_errors: per-row rejects (bad domain, email owned elsewhere, ...)
-- kept for a downloadable error report.
-- contacts.import_batch_id: stamps which import last touched a contact, exposed
-- as an "Import Batch" filter in the all-leads filter builder so an import can
-- be re-selected later (import -> filter by batch -> enrich).

BEGIN;

CREATE TABLE IF NOT EXISTS lead_import_batches (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    file_name TEXT,
    status TEXT NOT NULL DEFAULT 'processing', -- processing | completed | failed
    collision_strategy TEXT NOT NULL DEFAULT 'fill_blanks', -- fill_blanks | overwrite | skip
    column_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
    total_rows INTEGER NOT NULL DEFAULT 0,
    processed_rows INTEGER NOT NULL DEFAULT 0,
    created_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_lead_import_batches_agency_client
    ON lead_import_batches (agency_id, client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_import_errors (
    id BIGSERIAL PRIMARY KEY,
    batch_id BIGINT NOT NULL REFERENCES lead_import_batches(id) ON DELETE CASCADE,
    agency_id TEXT NOT NULL,
    row_number INTEGER,
    reason TEXT,
    raw_row JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lead_import_errors_batch
    ON lead_import_errors (batch_id, row_number);

ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS import_batch_id BIGINT REFERENCES lead_import_batches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_client_import_batch
    ON contacts (client_id, import_batch_id)
    WHERE import_batch_id IS NOT NULL;

-- FK covering indexes: without these, deleting a batch (SET NULL cascade)
-- would seq-scan contacts, and client-cascade deletes would scan batches.
CREATE INDEX IF NOT EXISTS idx_contacts_import_batch_fk
    ON contacts (import_batch_id)
    WHERE import_batch_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lead_import_batches_client
    ON lead_import_batches (client_id);

-- RLS: mirror 0022 — agency-scoped for browser clients; the Express server's
-- direct postgres connection bypasses RLS. (SELECT auth.uid()) is the
-- initplan form so it evaluates once per query, not per row.
ALTER TABLE lead_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_import_errors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lead_import_batches_agency ON lead_import_batches;
CREATE POLICY lead_import_batches_agency ON lead_import_batches
    FOR ALL USING (agency_id = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS lead_import_errors_agency ON lead_import_errors;
CREATE POLICY lead_import_errors_agency ON lead_import_errors
    FOR ALL USING (agency_id = (SELECT auth.uid())::text);

COMMIT;
