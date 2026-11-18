-- 0081_meta_ad_counts.sql
-- Active Meta ad count per domain (enrichment/stages/metaAdsBatch.js).
--
-- The count comes from Meta's Ad Library: Context.dev scrapes the search page
-- for the domain as an exact phrase (active ads, all countries) and we read
-- the "~N results" figure. Each agency uses its own Context.dev key
-- (agency_settings.context_dev_key, saved in the API Vault).
--
-- domain_meta_ads is keyed by domain, not by lead: a count can exist for a
-- domain that never becomes a lead (gated out, or an ads-only run), and
-- counting ads never writes to companies/contacts.
--   active_ads  last successful count (NULL = never counted)
--   checked_at  when that count was taken (NULL = never counted)
--   error       last attempt's error (NULL when the last attempt succeeded);
--               a failed attempt keeps the previous count and checked_at
--
-- job_domains.meta_ads_status records what this job did for the domain
-- ('counted' | 'reused' | 'error'), so a retried step skips finished domains.
--
-- Server-only table: RLS enabled with no policies (app connects as postgres).

BEGIN;

ALTER TABLE agency_settings ADD COLUMN IF NOT EXISTS context_dev_key TEXT;

CREATE TABLE IF NOT EXISTS domain_meta_ads (
    agency_id           TEXT NOT NULL,
    domain_normalized   TEXT NOT NULL,
    active_ads          INTEGER,
    checked_at          TIMESTAMPTZ,
    error               TEXT,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agency_id, domain_normalized)
);

ALTER TABLE domain_meta_ads ENABLE ROW LEVEL SECURITY;

ALTER TABLE job_domains ADD COLUMN IF NOT EXISTS meta_ads_status TEXT;

COMMIT;
