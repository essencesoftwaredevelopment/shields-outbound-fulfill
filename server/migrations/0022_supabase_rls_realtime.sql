-- 0022_supabase_rls_realtime.sql
-- Row-level security for browser clients; enable Realtime on jobs.
-- Service role / direct pool connections bypass RLS when using postgres superuser.
-- Run on Supabase: also enable replication for public.jobs in Dashboard > Database > Replication.

BEGIN;

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_serper_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_stage_checkpoints ENABLE ROW LEVEL SECURITY;

-- Jobs: agency owns rows
DROP POLICY IF EXISTS jobs_agency_select ON jobs;
CREATE POLICY jobs_agency_select ON jobs
    FOR SELECT USING (agency_id = auth.uid()::text);

DROP POLICY IF EXISTS jobs_agency_update ON jobs;
CREATE POLICY jobs_agency_update ON jobs
    FOR UPDATE USING (agency_id = auth.uid()::text);

-- Job domains / serper cache follow job ownership
DROP POLICY IF EXISTS job_domains_agency ON job_domains;
CREATE POLICY job_domains_agency ON job_domains
    FOR ALL USING (agency_id = auth.uid()::text);

DROP POLICY IF EXISTS job_serper_cache_via_job ON job_serper_cache;
CREATE POLICY job_serper_cache_via_job ON job_serper_cache
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM jobs j
            WHERE j.id = job_serper_cache.job_id
              AND j.agency_id = auth.uid()::text
        )
    );

DROP POLICY IF EXISTS job_queue_agency ON job_queue;
CREATE POLICY job_queue_agency ON job_queue
    FOR SELECT USING (agency_id = auth.uid()::text);

DROP POLICY IF EXISTS agency_settings_self ON agency_settings;
CREATE POLICY agency_settings_self ON agency_settings
    FOR ALL USING (agency_id = auth.uid()::text);

DROP POLICY IF EXISTS client_segments_agency ON client_segments;
CREATE POLICY client_segments_agency ON client_segments
    FOR ALL USING (agency_id = auth.uid()::text);

DROP POLICY IF EXISTS clients_agency ON clients;
CREATE POLICY clients_agency ON clients
    FOR ALL USING (agency_id = auth.uid()::text);

DROP POLICY IF EXISTS companies_agency ON companies;
CREATE POLICY companies_agency ON companies
    FOR ALL USING (agency_id = auth.uid()::text);

DROP POLICY IF EXISTS contacts_agency ON contacts;
CREATE POLICY contacts_agency ON contacts
    FOR ALL USING (agency_id = auth.uid()::text);

DROP POLICY IF EXISTS job_stage_checkpoints_agency ON job_stage_checkpoints;
CREATE POLICY job_stage_checkpoints_agency ON job_stage_checkpoints
    FOR ALL USING (agency_id = auth.uid()::text);

-- Realtime publication (Supabase managed schema)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE jobs;
    END IF;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
