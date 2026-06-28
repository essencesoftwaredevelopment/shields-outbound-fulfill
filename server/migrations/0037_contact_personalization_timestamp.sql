-- 0037_contact_personalization_timestamp.sql
-- Run-scoped personalization counting.
--
-- personalization_first_line had no completion timestamp, so per-run stage counts
-- (countJobStageStats) and resume eligibility (getPersonalizeQueue) could not tell
-- THIS run's work apart from a prior run's. Mirror the email_*_completed_at columns
-- (0024) and founder_find_completed_at (0034): stamp when a first line is written.
--
-- Schema only — additive, nullable column adds instantly (no table rewrite).

ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS personalization_completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_personalization_completed_at
    ON contacts (personalization_completed_at)
    WHERE personalization_completed_at IS NOT NULL;
