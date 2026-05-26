-- Email discovery vs SMTP verification (contacts table)
SELECT
  CASE
    WHEN email_find_completed_at IS NULL AND (email IS NULL OR BTRIM(email) = '') THEN 'find_not_run'
    WHEN email_find_completed_at IS NOT NULL AND (email IS NULL OR BTRIM(email) = '') THEN 'find_ran_not_found'
    WHEN email IS NOT NULL AND BTRIM(email) <> '' THEN 'email_present'
    ELSE 'other'
  END AS find_state,
  CASE
    WHEN email_verify_completed_at IS NULL THEN 'verify_not_run'
    ELSE 'verify_ran'
  END AS verify_state,
  COUNT(*) AS cnt
FROM contacts
GROUP BY 1, 2
ORDER BY cnt DESC;
