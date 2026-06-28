-- Separate founder discovery completion from full_name text.
--
-- Schema only — run this via migration runner.
-- Data backfill is too large for a single statement on Supabase; run the batched
-- script manually in the SQL editor instead:
--   migrations/0034_contact_founder_stage_timestamp_batched.sql

ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS founder_find_completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_founder_find_completed_at
    ON contacts (founder_find_completed_at)
    WHERE founder_find_completed_at IS NOT NULL;
