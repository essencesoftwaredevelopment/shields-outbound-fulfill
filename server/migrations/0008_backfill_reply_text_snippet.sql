-- Backfill reply_text_snippet from the existing payload JSONB column
UPDATE contact_instantly_events
SET reply_text_snippet = payload->>'reply_text_snippet'
WHERE reply_text_snippet IS NULL
  AND payload->>'reply_text_snippet' IS NOT NULL;
