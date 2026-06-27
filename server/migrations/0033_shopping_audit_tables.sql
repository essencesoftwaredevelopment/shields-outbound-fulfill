-- 0033_shopping_audit_tables.sql
-- Shopping ad audit pipeline tables (Vulcan / shopping_audit jobs).

BEGIN;

ALTER TABLE agency_settings
    ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS last_audit_at TIMESTAMPTZ;

ALTER TABLE contacts
    ADD COLUMN IF NOT EXISTS signal_emission_id BIGINT;

CREATE TABLE IF NOT EXISTS shopify_snapshots (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    domain_normalized TEXT NOT NULL,
    handle TEXT NOT NULL,
    product_id BIGINT NOT NULL,
    title TEXT NOT NULL,
    variants JSONB NOT NULL DEFAULT '[]'::jsonb,
    review_signals JSONB NOT NULL DEFAULT '{}'::jsonb,
    tags TEXT,
    image_count INTEGER NOT NULL DEFAULT 0,
    published_at TIMESTAMPTZ,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, domain_normalized, product_id)
);

CREATE INDEX IF NOT EXISTS idx_shopify_snapshots_client_domain
    ON shopify_snapshots (client_id, domain_normalized);

CREATE INDEX IF NOT EXISTS idx_shopify_snapshots_job
    ON shopify_snapshots (job_id);

CREATE TABLE IF NOT EXISTS hero_selections (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    shopify_snapshot_id BIGINT NOT NULL REFERENCES shopify_snapshots(id) ON DELETE CASCADE,
    domain_normalized TEXT NOT NULL,
    heuristic_version TEXT NOT NULL DEFAULT 'price_reviews_age',
    selection_reason JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (job_id, domain_normalized)
);

CREATE INDEX IF NOT EXISTS idx_hero_selections_job
    ON hero_selections (job_id);

CREATE TABLE IF NOT EXISTS ad_observations (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    hero_selection_id BIGINT REFERENCES hero_selections(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    branch TEXT NOT NULL CHECK (branch IN ('clean', 'ambiguous', 'none')),
    matched_card JSONB,
    all_cards JSONB NOT NULL DEFAULT '[]'::jsonb,
    source TEXT NOT NULL DEFAULT 'serper' CHECK (source IN ('serper', 'headless')),
    geo JSONB NOT NULL DEFAULT '{}'::jsonb,
    query_text TEXT,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_observations_job
    ON ad_observations (job_id);

CREATE INDEX IF NOT EXISTS idx_ad_observations_hero
    ON ad_observations (hero_selection_id);

CREATE TABLE IF NOT EXISTS signal_emissions (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    company_id BIGINT REFERENCES companies(id) ON DELETE SET NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    ad_observation_id BIGINT REFERENCES ad_observations(id) ON DELETE SET NULL,
    domain_normalized TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    tier INTEGER NOT NULL DEFAULT 3,
    observed JSONB NOT NULL DEFAULT '{}'::jsonb,
    expected JSONB NOT NULL DEFAULT '{}'::jsonb,
    competitor_ref JSONB,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (job_id, domain_normalized)
);

CREATE INDEX IF NOT EXISTS idx_signal_emissions_job
    ON signal_emissions (job_id);

CREATE INDEX IF NOT EXISTS idx_signal_emissions_client_type
    ON signal_emissions (client_id, signal_type);

ALTER TABLE contacts
    ADD CONSTRAINT contacts_signal_emission_id_fkey
    FOREIGN KEY (signal_emission_id) REFERENCES signal_emissions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS job_serper_shopping_cache (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    domain_normalized TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job_id, domain_normalized)
);

CREATE INDEX IF NOT EXISTS idx_job_serper_shopping_cache_job
    ON job_serper_shopping_cache (job_id);

-- RLS
ALTER TABLE shopify_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE hero_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_emissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_serper_shopping_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shopify_snapshots_agency ON shopify_snapshots;
CREATE POLICY shopify_snapshots_agency ON shopify_snapshots
    FOR ALL USING (agency_id = auth.uid()::text);

DROP POLICY IF EXISTS hero_selections_agency ON hero_selections;
CREATE POLICY hero_selections_agency ON hero_selections
    FOR ALL USING (agency_id = auth.uid()::text);

DROP POLICY IF EXISTS ad_observations_agency ON ad_observations;
CREATE POLICY ad_observations_agency ON ad_observations
    FOR ALL USING (agency_id = auth.uid()::text);

DROP POLICY IF EXISTS signal_emissions_agency ON signal_emissions;
CREATE POLICY signal_emissions_agency ON signal_emissions
    FOR ALL USING (agency_id = auth.uid()::text);

DROP POLICY IF EXISTS job_serper_shopping_cache_via_job ON job_serper_shopping_cache;
CREATE POLICY job_serper_shopping_cache_via_job ON job_serper_shopping_cache
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM jobs j
            WHERE j.id = job_serper_shopping_cache.job_id
              AND j.agency_id = auth.uid()::text
        )
    );

COMMIT;
