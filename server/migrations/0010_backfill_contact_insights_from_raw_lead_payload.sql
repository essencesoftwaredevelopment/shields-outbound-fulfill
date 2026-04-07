BEGIN;

WITH latest_snapshot AS (
    SELECT DISTINCT ON (cic.contact_id)
        cic.contact_id,
        c.agency_id,
        c.client_id,
        cic.instantly_lead_id,
        ic.instantly_campaign_id,
        ic.name AS campaign_name,
        c.email,
        co.domain_normalized,
        cic.raw_lead_payload
    FROM contact_instantly_campaigns cic
    JOIN contacts c ON c.id = cic.contact_id
    LEFT JOIN companies co ON co.id = c.company_id
    LEFT JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
    WHERE cic.raw_lead_payload IS NOT NULL
      AND cic.raw_lead_payload <> '{}'::jsonb
    ORDER BY cic.contact_id, cic.last_synced_at DESC NULLS LAST, cic.last_seen_at DESC NULLS LAST, cic.added_at DESC NULLS LAST
)
INSERT INTO contact_insights (
    contact_id,
    agency_id,
    client_id,
    source,
    attributes,
    source_payload
)
SELECT
    ls.contact_id,
    ls.agency_id,
    ls.client_id,
    'instantly_sync',
    jsonb_strip_nulls(
        jsonb_build_object(
            'instantlyLeadId', ls.instantly_lead_id,
            'instantlyCampaignId', ls.instantly_campaign_id,
            'instantlyCampaignName', ls.campaign_name,
            'firstName', COALESCE(ls.raw_lead_payload->>'first_name', ls.raw_lead_payload->>'firstName'),
            'lastName', COALESCE(ls.raw_lead_payload->>'last_name', ls.raw_lead_payload->>'lastName'),
            'fullName', COALESCE(ls.raw_lead_payload->>'name', ls.raw_lead_payload->>'full_name', ls.raw_lead_payload->>'fullName'),
            'email', LOWER(ls.email),
            'domain', ls.domain_normalized,
            'source', 'instantly_sync'
        )
        || COALESCE(ls.raw_lead_payload->'payload', '{}'::jsonb)
    ),
    jsonb_build_object(
        'source', 'instantly_sync_backfill',
        'rawLeadPayload', ls.raw_lead_payload
    )
FROM latest_snapshot ls
ON CONFLICT (contact_id)
DO UPDATE SET
    attributes = COALESCE(contact_insights.attributes, '{}'::jsonb) || EXCLUDED.attributes,
    source_payload = CASE
        WHEN EXCLUDED.source_payload = '{}'::jsonb THEN contact_insights.source_payload
        ELSE COALESCE(contact_insights.source_payload, '{}'::jsonb) || jsonb_build_object('instantly_sync_backfill', EXCLUDED.source_payload)
    END,
    updated_at = NOW();

COMMIT;
