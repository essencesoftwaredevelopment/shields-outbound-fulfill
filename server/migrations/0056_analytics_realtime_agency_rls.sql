-- 0056_analytics_realtime_agency_rls.sql
-- Authenticated Realtime for Analytics (pending review + Instantly events).
-- 0049 enabled RLS with no policies, so the browser's postgres_changes
-- subscriptions received nothing. Policies match jobs/contacts: tenant is
-- current_agency_id() (agency_auth_map). Channel filters still pin client_id.
-- REPLICA IDENTITY FULL on drafts so research_step UPDATEs match client_id filters.

BEGIN;

ALTER TABLE interested_autoresponder_drafts REPLICA IDENTITY FULL;

DROP POLICY IF EXISTS interested_autoresponder_drafts_agency_select ON interested_autoresponder_drafts;
CREATE POLICY interested_autoresponder_drafts_agency_select
    ON interested_autoresponder_drafts
    FOR SELECT
    TO authenticated
    USING (agency_id = (SELECT current_agency_id()));

DROP POLICY IF EXISTS contact_instantly_events_agency_select ON contact_instantly_events;
CREATE POLICY contact_instantly_events_agency_select
    ON contact_instantly_events
    FOR SELECT
    TO authenticated
    USING (agency_id = (SELECT current_agency_id()));

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE interested_autoresponder_drafts;
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END;
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE contact_instantly_events;
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END;
    END IF;
END $$;

COMMIT;
