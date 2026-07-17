-- 0042_spreadsheet_stage_markers.sql
-- Domain-level DNS status, idempotent Serper observations, and per-stage costs
-- outside jobs.stages JSON (avoids hot-row lock contention).

BEGIN;

-- ── DNS status on the domain queue (spreadsheet cell per domain) ─────────────
ALTER TABLE job_domains
    ADD COLUMN IF NOT EXISTS dns_status TEXT
        CHECK (dns_status IS NULL OR dns_status IN ('live', 'dead', 'unknown', 'skipped')),
    ADD COLUMN IF NOT EXISTS dns_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_job_domains_job_dns_status
    ON job_domains (job_id, dns_status)
    WHERE dns_status IS NOT NULL;

COMMENT ON COLUMN job_domains.dns_status IS
    'Per-domain DNS outcome: live|dead|unknown, or skipped when skipDomainCheck.';
COMMENT ON COLUMN job_domains.dns_checked_at IS
    'When dns_status was written for this job domain.';

-- ── Serper: one observation per job+domain (idempotent upserts) ─────────────
-- Keep the newest row when duplicates exist (retry/INSERT race residue).
DELETE FROM ad_observations a
USING ad_observations b
WHERE a.job_id = b.job_id
  AND a.domain_normalized IS NOT NULL
  AND b.domain_normalized IS NOT NULL
  AND a.domain_normalized = b.domain_normalized
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS ux_ad_observations_job_domain
    ON ad_observations (job_id, domain_normalized)
    WHERE domain_normalized IS NOT NULL;

-- ── Stage costs: narrow row per (job, stage), atomic increments only ─────────
CREATE TABLE IF NOT EXISTS job_stage_costs (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    agency_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    amount NUMERIC(12, 6) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_job_stage_costs_agency_job
    ON job_stage_costs (agency_id, job_id);

ALTER TABLE job_stage_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS job_stage_costs_agency ON job_stage_costs;
CREATE POLICY job_stage_costs_agency ON job_stage_costs
    FOR SELECT USING (agency_id = auth.uid()::text);

COMMENT ON TABLE job_stage_costs IS
    'Per-stage job cost ledger. Writers use atomic amount += delta; UI sums or reads by stage.';

-- ── UI progress RPC: spreadsheet counts by job_id (SECURITY INVOKER + RLS) ──
CREATE OR REPLACE FUNCTION public.get_job_stage_counts(p_job_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    j record;
    domain_counts jsonb;
    dns_counts jsonb;
    serper_counts jsonb;
    signal_counts jsonb;
    contact_counts jsonb;
    cost_counts jsonb;
    pipeline_mode text;
BEGIN
    SELECT id, agency_id, options, dedupe_stats, cost
      INTO j
      FROM jobs
     WHERE id = p_job_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    pipeline_mode := COALESCE(
        NULLIF(j.options->>'pipelineMode', ''),
        CASE
            WHEN j.options->>'nicheId' = 'shopping_audit'
              OR j.options->>'industry' = 'shopping_audit'
            THEN 'shopping_audit'
            ELSE 'standard'
        END
    );

    SELECT jsonb_build_object(
        'total', COUNT(*)::int,
        'pending', COUNT(*) FILTER (WHERE status = 'pending')::int,
        'processing', COUNT(*) FILTER (WHERE status = 'processing')::int,
        'done', COUNT(*) FILTER (WHERE status = 'done')::int,
        'skipped', COUNT(*) FILTER (WHERE status = 'skipped')::int,
        'processable', COUNT(*) FILTER (WHERE status IN ('pending', 'processing', 'done'))::int
    )
      INTO domain_counts
      FROM job_domains
     WHERE job_id = p_job_id;

    SELECT jsonb_build_object(
        'checked', COUNT(*) FILTER (WHERE dns_status IS NOT NULL)::int,
        'live', COUNT(*) FILTER (WHERE dns_status = 'live')::int,
        'dead', COUNT(*) FILTER (WHERE dns_status = 'dead')::int,
        'unknown', COUNT(*) FILTER (WHERE dns_status = 'unknown')::int,
        'skipped', COUNT(*) FILTER (WHERE dns_status = 'skipped')::int
    )
      INTO dns_counts
      FROM job_domains
     WHERE job_id = p_job_id;

    SELECT jsonb_build_object(
        'processed', COUNT(*)::int,
        'matched', COUNT(*) FILTER (WHERE matched IS TRUE)::int,
        'none', COUNT(*) FILTER (WHERE matched IS NOT TRUE)::int
    )
      INTO serper_counts
      FROM ad_observations
     WHERE job_id = p_job_id
       AND domain_normalized IS NOT NULL;

    SELECT jsonb_build_object(
        'signals', COUNT(*)::int
    )
      INTO signal_counts
      FROM signal_emissions
     WHERE job_id = p_job_id;

    SELECT jsonb_build_object(
        'total', COUNT(*)::int,
        'founderDone', COUNT(*) FILTER (WHERE founder_find_completed_at IS NOT NULL)::int,
        'founderFound', COUNT(*) FILTER (
            WHERE founder_find_completed_at IS NOT NULL
              AND full_name IS NOT NULL AND BTRIM(full_name) <> ''
              AND LOWER(BTRIM(full_name)) <> 'not found'
        )::int,
        'emailDone', COUNT(*) FILTER (WHERE email_find_completed_at IS NOT NULL)::int,
        'emailFound', COUNT(*) FILTER (
            WHERE email IS NOT NULL AND BTRIM(email) <> ''
        )::int,
        'verifyDone', COUNT(*) FILTER (WHERE email_verify_completed_at IS NOT NULL)::int,
        'valid', COUNT(*) FILTER (
            WHERE email_verify_completed_at IS NOT NULL
              AND LOWER(TRIM(COALESCE(email_status, ''))) = 'valid'
        )::int,
        'invalid', COUNT(*) FILTER (
            WHERE email_verify_completed_at IS NOT NULL
              AND LOWER(TRIM(COALESCE(email_status, ''))) = 'invalid'
        )::int,
        'unknown', COUNT(*) FILTER (
            WHERE email_verify_completed_at IS NOT NULL
              AND LOWER(TRIM(COALESCE(email_status, ''))) = 'unknown'
        )::int,
        'validRisky', COUNT(*) FILTER (
            WHERE email_verify_completed_at IS NOT NULL
              AND LOWER(TRIM(COALESCE(email_status, ''))) IN ('valid-risky', 'risky')
        )::int,
        'personalizeDone', COUNT(*) FILTER (WHERE personalization_completed_at IS NOT NULL)::int,
        'personalized', COUNT(*) FILTER (
            WHERE personalization_completed_at IS NOT NULL
              AND personalization_first_line IS NOT NULL
              AND BTRIM(personalization_first_line) <> ''
              AND personalization_first_line NOT IN ('[Generation failed]', 'invalid')
        )::int
    )
      INTO contact_counts
      FROM contacts
     WHERE job_id = p_job_id;

    SELECT COALESCE(
        jsonb_object_agg(stage, amount),
        '{}'::jsonb
    )
      INTO cost_counts
      FROM job_stage_costs
     WHERE job_id = p_job_id;

    RETURN jsonb_build_object(
        'jobId', p_job_id,
        'pipelineMode', pipeline_mode,
        'jobCost', COALESCE(j.cost, 0),
        'domainCheckSkipped', COALESCE((j.dedupe_stats->>'domainCheckSkipped')::boolean, false)
            OR COALESCE((j.options->>'skipDomainCheck')::boolean, false),
        'domainPrep', domain_counts || jsonb_build_object('dns', dns_counts),
        'serperShopping', serper_counts,
        'signalWaterfall', signal_counts || jsonb_build_object(
            'done', (domain_counts->>'done')::int,
            'skipped', (domain_counts->>'skipped')::int,
            'pending', (domain_counts->>'pending')::int
        ),
        'founders', jsonb_build_object(
            'processed', (contact_counts->>'founderDone')::int,
            'found', (contact_counts->>'founderFound')::int
        ),
        'emailDiscovery', jsonb_build_object(
            'processed', (contact_counts->>'emailDone')::int,
            'found', (contact_counts->>'emailFound')::int
        ),
        'verification', jsonb_build_object(
            'verified', (contact_counts->>'verifyDone')::int,
            'valid', (contact_counts->>'valid')::int,
            'invalid', (contact_counts->>'invalid')::int,
            'unknown', (contact_counts->>'unknown')::int,
            'validRisky', (contact_counts->>'validRisky')::int
        ),
        'personalization', jsonb_build_object(
            'processed', (contact_counts->>'personalizeDone')::int,
            'personalized', (contact_counts->>'personalized')::int
        ),
        'costs', cost_counts,
        'contacts', contact_counts
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_job_stage_counts(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_job_stage_counts(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_job_stage_counts(text) TO service_role;

COMMENT ON FUNCTION public.get_job_stage_counts(text) IS
    'Spreadsheet stage counts for a job. SECURITY INVOKER so jobs/contacts RLS applies.';

COMMIT;
