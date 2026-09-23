-- 0063_client_analytics_snapshots.sql
-- Precomputed Analytics-tab "core" payload (headline numbers + chart buckets for
-- emails sent / positive replies / meetings booked) per client and period.
--
-- Refreshed every ~10 min by the Express server's snapshot sweep
-- (services/analyticsSnapshots.js); the analytics route serves it instead of
-- re-aggregating contact_instantly_events on every period switch.
-- All-campaigns view only; campaign-filtered views are computed live.
-- Server-only (pg pool): RLS on with no policies keeps it off the Data API.

BEGIN;

CREATE TABLE IF NOT EXISTS client_analytics_snapshots (
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    period TEXT NOT NULL CHECK (period IN ('24h', '7d', '30d', '90d')),
    payload JSONB NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agency_id, client_id, period)
);

ALTER TABLE client_analytics_snapshots ENABLE ROW LEVEL SECURITY;

COMMIT;
