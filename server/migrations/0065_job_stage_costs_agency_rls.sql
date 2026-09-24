-- 0065_job_stage_costs_agency_rls.sql
-- 0042's policy compared agency_id to auth.uid(), but agency ids are not
-- Supabase user ids (the tenant comes from agency_auth_map). The browser's
-- get_job_stage_counts (SECURITY INVOKER) therefore saw no cost rows and every
-- Pipeline stage card showed $0.00. Match jobs/contacts: current_agency_id().

BEGIN;

DROP POLICY IF EXISTS job_stage_costs_agency ON job_stage_costs;
CREATE POLICY job_stage_costs_agency
    ON job_stage_costs
    FOR SELECT
    TO authenticated
    USING (agency_id = (SELECT current_agency_id()));

COMMIT;
