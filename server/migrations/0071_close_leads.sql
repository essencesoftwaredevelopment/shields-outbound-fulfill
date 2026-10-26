-- 0071_close_leads.sql
-- Close.com as the dialer for positive replies (features.closeLeads +
-- agency_settings.close_key). When a lead replies interested, a Close lead is
-- created (or an existing one with that email is linked) with the founder's
-- name, email, phone and company domain, and the review page / ntfy alert link
-- straight to it.
--
-- State lives on the contact so a lead is never pushed to Close twice:
--   close_status   pending — sync claimed, Close call in flight
--                  synced  — close_lead_id set
--                  error   — Close call failed; retried on the next reply
--   close_checked_at  last attempt (also the claim time, so a crashed claim expires)
--   close_phone    the number last written to the Close contact, so a phone the
--                  Enrow lookup finds later (timeout → next reply) is added then.

BEGIN;

ALTER TABLE agency_settings ADD COLUMN IF NOT EXISTS close_key TEXT;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS close_lead_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS close_contact_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS close_phone TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS close_status TEXT
    CHECK (close_status IS NULL OR close_status IN ('pending', 'synced', 'error'));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS close_error TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS close_checked_at TIMESTAMPTZ;

COMMIT;
