-- Add reply_text_snippet column to contact_instantly_events
ALTER TABLE contact_instantly_events
  ADD COLUMN IF NOT EXISTS reply_text_snippet TEXT;
