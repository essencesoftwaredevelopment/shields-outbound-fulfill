BEGIN;

ALTER TABLE contact_insights
    ADD COLUMN IF NOT EXISTS uses_shopify BOOLEAN;

COMMIT;
