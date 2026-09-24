-- 0067_contact_phone.sql
-- Founder phone numbers from Enrow's Phone Finder, looked up when a lead replies
-- positively (features.enrowPhoneLookup + agency_settings.enrow_key).
--
-- Enrow charges when a search is LAUNCHED (not when a number is found), so the
-- attempt state lives on the contact and a lead is never searched twice:
--   phone_status     pending   — search claimed / submitted, result not in yet
--                    found     — phone + phone_country set
--                    not_found — Enrow had nothing; never re-searched
--                    timeout   — still ongoing when we stopped polling; the next
--                                reply re-polls phone_search_id (GETs are free)
--                    error     — submit failed (credits, auth, plan); retryable
--   phone_search_id  Enrow search id, so a crashed/timed-out run resumes polling
--                    the paid search instead of launching a new one.

BEGIN;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_country TEXT;
-- 'enrow' today; NULL = no number.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_source TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_status TEXT
    CHECK (phone_status IS NULL OR phone_status IN ('pending', 'found', 'not_found', 'timeout', 'error'));
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_search_id TEXT;
-- Which input the search used: 'linkedin' or 'name' (bad-number forensics).
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_search_input TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_credits_used NUMERIC;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_error TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_checked_at TIMESTAMPTZ;

COMMIT;
