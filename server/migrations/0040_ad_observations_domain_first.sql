-- Domain-first Serper Shopping matching: the audit qualifier becomes an explicit
-- binary `matched` (seller card reverse-matched to a catalog product) instead of
-- the clean/ambiguous/none branch inference. `branch` keeps being written
-- (derived from the matched card) for back-compat with existing rows, the export
-- LATERAL ordering, and metrics; drop it in a later cleanup migration.
ALTER TABLE ad_observations
    ADD COLUMN IF NOT EXISTS matched boolean NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS matched_product jsonb,
    ADD COLUMN IF NOT EXISTS matched_snapshot_id BIGINT REFERENCES shopify_snapshots(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS seller_match_method text,
    ADD COLUMN IF NOT EXISTS match_similarity numeric,
    ADD COLUMN IF NOT EXISTS catalog_pages_fetched integer;

-- Legacy semantics: any non-'none' branch meant a matched card was found.
UPDATE ad_observations SET matched = TRUE WHERE branch <> 'none' AND matched = FALSE;

CREATE INDEX IF NOT EXISTS idx_ad_observations_job_matched
    ON ad_observations (job_id, matched);

COMMENT ON COLUMN ad_observations.matched IS
    'Binary qualifier: a seller-matched Shopping card reverse-matched a catalog product title.';
COMMENT ON COLUMN ad_observations.matched_product IS
    'Snapshot row (title, handle, product_id, variants, review_signals) of the matched catalog product.';
COMMENT ON COLUMN ad_observations.seller_match_method IS
    'How the card seller matched the brand: substring | concat | legacy_similarity.';
COMMENT ON COLUMN ad_observations.match_similarity IS
    'Lenient token-overlap similarity of the winning card-title vs product-title pair.';
