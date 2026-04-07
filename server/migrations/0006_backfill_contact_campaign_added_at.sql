BEGIN;

UPDATE contact_instantly_campaigns
SET added_at = source.added_at
FROM (
    SELECT
        contact_id,
        campaign_id,
        CASE
            WHEN COALESCE(raw_lead_payload->>'timestamp_created', '') ~ '^\d{4}-\d{2}-\d{2}T'
                THEN (raw_lead_payload->>'timestamp_created')::timestamptz
            WHEN COALESCE(raw_lead_payload->>'created_at', '') ~ '^\d{4}-\d{2}-\d{2}T'
                THEN (raw_lead_payload->>'created_at')::timestamptz
            ELSE NULL
        END AS added_at
    FROM contact_instantly_campaigns
) AS source
WHERE contact_instantly_campaigns.contact_id = source.contact_id
  AND contact_instantly_campaigns.campaign_id = source.campaign_id
  AND source.added_at IS NOT NULL
  AND contact_instantly_campaigns.added_at IS DISTINCT FROM source.added_at;

COMMIT;
