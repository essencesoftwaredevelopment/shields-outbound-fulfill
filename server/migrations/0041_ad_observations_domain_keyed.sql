-- Serper-first shopping audit: observations are keyed by domain, not by hero
-- selection. The shopifyCatalog/heroSelection stages are removed — the serper
-- stage queries the bare domain first and fetches the catalog on demand only
-- for seller-matched cards. hero_selection_id stays for legacy rows.
ALTER TABLE ad_observations
    ADD COLUMN IF NOT EXISTS domain_normalized TEXT;

UPDATE ad_observations ao
SET domain_normalized = hs.domain_normalized
FROM hero_selections hs
WHERE ao.hero_selection_id = hs.id AND ao.domain_normalized IS NULL;

CREATE INDEX IF NOT EXISTS idx_ad_observations_job_domain
    ON ad_observations (job_id, domain_normalized);
