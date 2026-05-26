-- Separate email discovery vs SMTP verification completion from email_status.
-- Backfill from last_verified_at, then drop last_verified_at.
-- Large DBs (~400k contacts): run via psql or migration runner; may take several minutes.

ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS email_find_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS email_verify_completed_at TIMESTAMPTZ;

-- Verification stage previously persisted as last_verified_at
UPDATE contacts
SET email_verify_completed_at = last_verified_at
WHERE last_verified_at IS NOT NULL
  AND email_verify_completed_at IS NULL;

-- Legacy: finder wrote not_found as email_status = invalid with no email
UPDATE contacts
SET
    email_find_completed_at = COALESCE(email_find_completed_at, updated_at),
    email_status = NULL
WHERE (email IS NULL OR BTRIM(email) = '')
  AND email_status IN ('invalid', 'unknown')
  AND last_verified_at IS NULL
  AND email_verify_completed_at IS NULL;

-- Legacy: finder found email (status set) but verification not run yet
UPDATE contacts
SET email_find_completed_at = COALESCE(email_find_completed_at, updated_at)
WHERE email IS NOT NULL
  AND BTRIM(email) <> ''
  AND email_status IS NOT NULL
  AND BTRIM(email_status) <> ''
  AND last_verified_at IS NULL
  AND email_verify_completed_at IS NULL
  AND email_find_completed_at IS NULL;

-- Verified contacts: ensure find timestamp exists when we have verification time
UPDATE contacts
SET email_find_completed_at = COALESCE(email_find_completed_at, email_verify_completed_at, updated_at)
WHERE email IS NOT NULL
  AND BTRIM(email) <> ''
  AND email_verify_completed_at IS NOT NULL
  AND email_find_completed_at IS NULL;

ALTER TABLE contacts DROP COLUMN IF EXISTS last_verified_at;

CREATE INDEX IF NOT EXISTS idx_contacts_email_find_completed_at
    ON contacts (email_find_completed_at)
    WHERE email_find_completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_email_verify_completed_at
    ON contacts (email_verify_completed_at)
    WHERE email_verify_completed_at IS NOT NULL;
