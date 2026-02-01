SELECT inferred_status, COUNT(*)
FROM (
  SELECT
    CASE
      WHEN email IS NOT NULL THEN 'email_found'
      WHEN email_status = 'invalid' THEN 'email_ran_not_found'
      WHEN email_status IS NOT NULL THEN 'email_ran_' || email_status
      WHEN full_name ILIKE '%not found%' THEN 'founder_ran_not_found'
      WHEN full_name IS NOT NULL THEN 'founder_found'
      ELSE 'no_signal'
    END AS inferred_status
  FROM contacts
) s
GROUP BY inferred_status;