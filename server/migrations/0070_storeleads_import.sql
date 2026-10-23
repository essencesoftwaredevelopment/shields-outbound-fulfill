-- 0070_storeleads_import.sql
-- Store Leads (storeleads.app) imports into the lead bank.
--
-- agency_settings.storeleads_key: the agency's own Store Leads API key (vault).
--   Only present while the agency holds a Store Leads subscription; imports are
--   run by hand from the leads tab, never on a schedule.
-- companies.*: store-level facts from Store Leads. They describe the domain, not
--   a contact, so they live on companies (one row per client + domain) and are
--   refreshed wholesale on every import/backfill. store_state is Store Leads'
--   Active | Inactive | Password Protected | Redirect, plus 'Not Found' when a
--   backfill lookup had no match (so the domain isn't re-queried until stale).
-- lead_import_batches.source/options: Store Leads runs reuse the CSV import
--   batch rows for progress + the "Import Batch" filter; options keeps the
--   filters a run used.
--
-- All columns are nullable/defaulted, so the ALTERs are metadata-only.

BEGIN;

ALTER TABLE agency_settings
    ADD COLUMN IF NOT EXISTS storeleads_key TEXT;

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS est_monthly_sales_usd NUMERIC(14, 2),
    ADD COLUMN IF NOT EXISTS country_code TEXT,
    ADD COLUMN IF NOT EXISTS store_platform TEXT,
    ADD COLUMN IF NOT EXISTS store_plan TEXT,
    ADD COLUMN IF NOT EXISTS store_state TEXT,
    ADD COLUMN IF NOT EXISTS store_apps TEXT[],
    ADD COLUMN IF NOT EXISTS store_technologies TEXT[],
    ADD COLUMN IF NOT EXISTS storeleads_synced_at TIMESTAMPTZ;

ALTER TABLE lead_import_batches
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'csv', -- csv | storeleads
    ADD COLUMN IF NOT EXISTS options JSONB;

COMMIT;
