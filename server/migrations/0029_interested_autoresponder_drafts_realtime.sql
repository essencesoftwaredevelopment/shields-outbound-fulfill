-- 0029_interested_autoresponder_drafts_realtime.sql
-- Enable Supabase Realtime on interested_autoresponder_drafts for analytics pending-review panel.

BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE interested_autoresponder_drafts;
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
