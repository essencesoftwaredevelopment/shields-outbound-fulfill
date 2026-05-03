-- Rename email_sent events from the interested_autoresponder source to a distinct event_type.
-- This allows the UI to differentiate autoresponder follow-up emails from regular campaign emails.

UPDATE contact_instantly_events
SET
    event_type = 'interested_reply_sent',
    payload    = payload || '{"event_type": "interested_reply_sent"}'::jsonb
WHERE
    source     = 'interested_autoresponder'
    AND event_type = 'email_sent';
