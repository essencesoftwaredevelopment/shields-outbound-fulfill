WITH duplicate_company_role AS (
    SELECT COUNT(*)::bigint AS violations
    FROM (
        SELECT company_id, role_type
        FROM contacts
        GROUP BY company_id, role_type
        HAVING COUNT(*) > 1
    ) d
),
duplicate_agency_email AS (
    SELECT COUNT(*)::bigint AS violations
    FROM (
        SELECT agency_id, LOWER(email)
        FROM contacts
        WHERE email IS NOT NULL AND BTRIM(email) <> ''
        GROUP BY agency_id, LOWER(email)
        HAVING COUNT(*) > 1
    ) d
),
orphan_company_client AS (
    SELECT COUNT(*)::bigint AS violations
    FROM companies co
    LEFT JOIN clients cl ON cl.id = co.client_id
    WHERE co.client_id IS NOT NULL AND cl.id IS NULL
),
orphan_contact_company AS (
    SELECT COUNT(*)::bigint AS violations
    FROM contacts ct
    LEFT JOIN companies co ON co.id = ct.company_id
    WHERE co.id IS NULL
),
orphan_contact_client AS (
    SELECT COUNT(*)::bigint AS violations
    FROM contacts ct
    LEFT JOIN clients cl ON cl.id = ct.client_id
    WHERE ct.client_id IS NOT NULL AND cl.id IS NULL
),
orphan_campaign_client AS (
    SELECT COUNT(*)::bigint AS violations
    FROM instantly_campaigns ic
    LEFT JOIN clients cl ON cl.id = ic.client_id
    WHERE cl.id IS NULL
),
orphan_link_contact AS (
    SELECT COUNT(*)::bigint AS violations
    FROM contact_instantly_campaigns cic
    LEFT JOIN contacts ct ON ct.id = cic.contact_id
    WHERE ct.id IS NULL
),
orphan_link_campaign AS (
    SELECT COUNT(*)::bigint AS violations
    FROM contact_instantly_campaigns cic
    LEFT JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
    WHERE ic.id IS NULL
),
invalid_checkpoint_stage AS (
    SELECT COUNT(*)::bigint AS violations
    FROM job_stage_checkpoints
    WHERE stage NOT IN ('founder', 'email_find', 'verify', 'personalize')
),
required_field_violations AS (
    SELECT COUNT(*)::bigint AS violations
    FROM (
        SELECT 1
        FROM clients
        WHERE agency_id IS NULL OR name IS NULL
        UNION ALL
        SELECT 1
        FROM companies
        WHERE agency_id IS NULL OR domain_normalized IS NULL
        UNION ALL
        SELECT 1
        FROM contacts
        WHERE agency_id IS NULL OR company_id IS NULL OR role_type IS NULL
        UNION ALL
        SELECT 1
        FROM instantly_campaigns
        WHERE agency_id IS NULL OR client_id IS NULL OR instantly_campaign_id IS NULL OR name IS NULL
        UNION ALL
        SELECT 1
        FROM contact_instantly_campaigns
        WHERE contact_id IS NULL OR campaign_id IS NULL
        UNION ALL
        SELECT 1
        FROM job_stage_checkpoints
        WHERE agency_id IS NULL OR job_id IS NULL OR stage IS NULL OR cursor IS NULL
    ) violations
)
SELECT
    'duplicate_company_role' AS check_name,
    CASE WHEN violations = 0 THEN 'pass' ELSE 'fail' END AS status,
    violations::text AS details
FROM duplicate_company_role

UNION ALL

SELECT
    'duplicate_agency_email',
    CASE WHEN violations = 0 THEN 'pass' ELSE 'fail' END,
    violations::text
FROM duplicate_agency_email

UNION ALL

SELECT
    'orphan_company_client',
    CASE WHEN violations = 0 THEN 'pass' ELSE 'fail' END,
    violations::text
FROM orphan_company_client

UNION ALL

SELECT
    'orphan_contact_company',
    CASE WHEN violations = 0 THEN 'pass' ELSE 'fail' END,
    violations::text
FROM orphan_contact_company

UNION ALL

SELECT
    'orphan_contact_client',
    CASE WHEN violations = 0 THEN 'pass' ELSE 'fail' END,
    violations::text
FROM orphan_contact_client

UNION ALL

SELECT
    'orphan_campaign_client',
    CASE WHEN violations = 0 THEN 'pass' ELSE 'fail' END,
    violations::text
FROM orphan_campaign_client

UNION ALL

SELECT
    'orphan_link_contact',
    CASE WHEN violations = 0 THEN 'pass' ELSE 'fail' END,
    violations::text
FROM orphan_link_contact

UNION ALL

SELECT
    'orphan_link_campaign',
    CASE WHEN violations = 0 THEN 'pass' ELSE 'fail' END,
    violations::text
FROM orphan_link_campaign

UNION ALL

SELECT
    'invalid_checkpoint_stage',
    CASE WHEN violations = 0 THEN 'pass' ELSE 'fail' END,
    violations::text
FROM invalid_checkpoint_stage

UNION ALL

SELECT
    'required_field_violations',
    CASE WHEN violations = 0 THEN 'pass' ELSE 'fail' END,
    violations::text
FROM required_field_violations

ORDER BY check_name;
