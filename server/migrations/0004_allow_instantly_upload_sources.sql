BEGIN;

ALTER TABLE contact_instantly_campaigns
    DROP CONSTRAINT IF EXISTS contact_instantly_campaigns_upload_source_check;

ALTER TABLE contact_instantly_campaigns
    ADD CONSTRAINT contact_instantly_campaigns_upload_source_check
    CHECK (
        upload_source = ANY (
            ARRAY[
                'pipeline'::text,
                'manual'::text,
                'instantly_sync'::text,
                'instantly_webhook'::text
            ]
        )
    );

COMMIT;
