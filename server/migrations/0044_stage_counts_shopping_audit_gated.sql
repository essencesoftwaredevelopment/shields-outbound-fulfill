-- 0044_stage_counts_shopping_audit_gated.sql
-- Only attach serperShopping / signalWaterfall payloads for shopping_audit jobs.
-- Standard jobs were receiving zeroed serper objects + domain-done mirrored into
-- signalWaterfall.done, which the UI treated as a shopping-audit run.

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
    dns_processable int;
    result jsonb;
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
        'queueActive', COUNT(*) FILTER (WHERE status IN ('pending', 'processing', 'done'))::int
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

    SELECT COUNT(*) FILTER (
        WHERE dns_status IS DISTINCT FROM 'dead'
    )::int
      INTO dns_processable
      FROM job_domains
     WHERE job_id = p_job_id;

    domain_counts := domain_counts || jsonb_build_object(
        'processable', dns_processable,
        'dns', dns_counts
    );

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

    result := jsonb_build_object(
        'jobId', p_job_id,
        'pipelineMode', pipeline_mode,
        'jobCost', COALESCE(j.cost, 0),
        'domainCheckSkipped', COALESCE((j.dedupe_stats->>'domainCheckSkipped')::boolean, false)
            OR COALESCE((j.options->>'skipDomainCheck')::boolean, false),
        'domainPrep', domain_counts,
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

    IF pipeline_mode = 'shopping_audit' THEN
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

        result := result || jsonb_build_object(
            'serperShopping', serper_counts,
            'signalWaterfall', signal_counts || jsonb_build_object(
                'done', (domain_counts->>'done')::int,
                'skipped', (domain_counts->>'skipped')::int,
                'pending', (domain_counts->>'pending')::int
            )
        );
    END IF;

    RETURN result;
END;
$$;
