-- 0023_agency_auth_map.sql
-- Maps Supabase Auth user UUID -> legacy agency_id (e.g. Firebase uid) for RLS and existing SQL rows.
-- Browser policies use current_agency_id(); server middleware resolves the same mapping in app code.
--
-- Run as role "postgres" in Supabase SQL Editor (not anon/authenticated).
-- Or: supabase db push / MCP apply_migration.

BEGIN;

CREATE TABLE IF NOT EXISTS agency_auth_map (
    supabase_user_id UUID PRIMARY KEY,
    agency_id TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note TEXT
);

COMMENT ON TABLE agency_auth_map IS 'Links Supabase auth.users.id to legacy agency_id used in business tables';

-- Resolve tenant for RLS: mapped legacy id, else auth.uid() as text (greenfield users).
CREATE OR REPLACE FUNCTION public.current_agency_id()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT m.agency_id FROM agency_auth_map m WHERE m.supabase_user_id = auth.uid()),
        auth.uid()::text
    );
$$;

REVOKE ALL ON FUNCTION public.current_agency_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_agency_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_agency_id() TO anon;

ALTER TABLE agency_auth_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agency_auth_map_select_self ON agency_auth_map;
CREATE POLICY agency_auth_map_select_self ON agency_auth_map
    FOR SELECT USING (supabase_user_id = auth.uid());

-- Recreate tenant policies (from 0022) using current_agency_id().

DROP POLICY IF EXISTS jobs_agency_select ON jobs;
CREATE POLICY jobs_agency_select ON jobs
    FOR SELECT USING (agency_id = current_agency_id());

DROP POLICY IF EXISTS jobs_agency_update ON jobs;
CREATE POLICY jobs_agency_update ON jobs
    FOR UPDATE USING (agency_id = current_agency_id());

DROP POLICY IF EXISTS job_domains_agency ON job_domains;
CREATE POLICY job_domains_agency ON job_domains
    FOR ALL USING (agency_id = current_agency_id());

DROP POLICY IF EXISTS job_serper_cache_via_job ON job_serper_cache;
CREATE POLICY job_serper_cache_via_job ON job_serper_cache
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM jobs j
            WHERE j.id = job_serper_cache.job_id
              AND j.agency_id = current_agency_id()
        )
    );

DROP POLICY IF EXISTS job_queue_agency ON job_queue;
CREATE POLICY job_queue_agency ON job_queue
    FOR SELECT USING (agency_id = current_agency_id());

DROP POLICY IF EXISTS agency_settings_self ON agency_settings;
CREATE POLICY agency_settings_self ON agency_settings
    FOR ALL USING (agency_id = current_agency_id());

DROP POLICY IF EXISTS client_segments_agency ON client_segments;
CREATE POLICY client_segments_agency ON client_segments
    FOR ALL USING (agency_id = current_agency_id());

DROP POLICY IF EXISTS clients_agency ON clients;
CREATE POLICY clients_agency ON clients
    FOR ALL USING (agency_id = current_agency_id());

DROP POLICY IF EXISTS companies_agency ON companies;
CREATE POLICY companies_agency ON companies
    FOR ALL USING (agency_id = current_agency_id());

DROP POLICY IF EXISTS contacts_agency ON contacts;
CREATE POLICY contacts_agency ON contacts
    FOR ALL USING (agency_id = current_agency_id());

DROP POLICY IF EXISTS job_stage_checkpoints_agency ON job_stage_checkpoints;
CREATE POLICY job_stage_checkpoints_agency ON job_stage_checkpoints
    FOR ALL USING (agency_id = current_agency_id());

COMMIT;

-- One-time seed (run in SQL editor after migration; adjust UUIDs/emails as needed):
--
-- INSERT INTO agency_auth_map (supabase_user_id, agency_id, note)
-- VALUES (
--     '98aaab5e-c3e3-403f-8bce-3d8fb0b975e3'::uuid,
--     'HoPJjMpaKjMqw6TCjlzz9jYEoFM2',
--     'jacques@essenceretention.com -> essence agency'
-- )
-- ON CONFLICT (supabase_user_id) DO UPDATE SET
--     agency_id = EXCLUDED.agency_id,
--     note = EXCLUDED.note;
