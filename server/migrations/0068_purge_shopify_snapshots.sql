-- Drop the stored Shopify catalog. Hero selections and ad observations stay;
-- they only pointed at snapshot ids for product title fallback.
-- ON DELETE SET NULL so a later purge cannot cascade into audit results.

BEGIN;

ALTER TABLE hero_selections
    ALTER COLUMN shopify_snapshot_id DROP NOT NULL;

ALTER TABLE hero_selections
    DROP CONSTRAINT hero_selections_shopify_snapshot_id_fkey;

ALTER TABLE ad_observations
    DROP CONSTRAINT ad_observations_matched_snapshot_id_fkey;

UPDATE hero_selections
SET shopify_snapshot_id = NULL
WHERE shopify_snapshot_id IS NOT NULL;

UPDATE ad_observations
SET matched_snapshot_id = NULL
WHERE matched_snapshot_id IS NOT NULL;

TRUNCATE shopify_snapshots RESTART IDENTITY;

ALTER TABLE hero_selections
    ADD CONSTRAINT hero_selections_shopify_snapshot_id_fkey
    FOREIGN KEY (shopify_snapshot_id) REFERENCES shopify_snapshots(id) ON DELETE SET NULL;

ALTER TABLE ad_observations
    ADD CONSTRAINT ad_observations_matched_snapshot_id_fkey
    FOREIGN KEY (matched_snapshot_id) REFERENCES shopify_snapshots(id) ON DELETE SET NULL;

COMMIT;
