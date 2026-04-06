WITH table_checks AS (
    SELECT
        'clients'::text AS table_name,
        COUNT(*)::bigint AS row_count,
        COALESCE(
            MD5(STRING_AGG(MD5(TO_JSONB(t)::text), '' ORDER BY t.id::text)),
            'empty'
        ) AS row_checksum
    FROM clients t

    UNION ALL

    SELECT
        'companies'::text,
        COUNT(*)::bigint,
        COALESCE(
            MD5(STRING_AGG(MD5(TO_JSONB(t)::text), '' ORDER BY t.id::text)),
            'empty'
        )
    FROM companies t

    UNION ALL

    SELECT
        'contacts'::text,
        COUNT(*)::bigint,
        COALESCE(
            MD5(STRING_AGG(MD5(TO_JSONB(t)::text), '' ORDER BY t.id::text)),
            'empty'
        )
    FROM contacts t

    UNION ALL

    SELECT
        'instantly_campaigns'::text,
        COUNT(*)::bigint,
        COALESCE(
            MD5(STRING_AGG(MD5(TO_JSONB(t)::text), '' ORDER BY t.id::text)),
            'empty'
        )
    FROM instantly_campaigns t

    UNION ALL

    SELECT
        'contact_instantly_campaigns'::text,
        COUNT(*)::bigint,
        COALESCE(
            MD5(
                STRING_AGG(
                    MD5(TO_JSONB(t)::text),
                    ''
                    ORDER BY t.contact_id::text, t.campaign_id::text
                )
            ),
            'empty'
        )
    FROM contact_instantly_campaigns t

    UNION ALL

    SELECT
        'job_stage_checkpoints'::text,
        COUNT(*)::bigint,
        COALESCE(
            MD5(
                STRING_AGG(
                    MD5(TO_JSONB(t)::text),
                    ''
                    ORDER BY t.agency_id, t.job_id, t.stage
                )
            ),
            'empty'
        )
    FROM job_stage_checkpoints t
)
SELECT table_name, row_count, row_checksum
FROM table_checks
ORDER BY table_name;
