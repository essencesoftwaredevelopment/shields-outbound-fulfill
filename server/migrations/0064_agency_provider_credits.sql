-- 0064_agency_provider_credits.sql
-- Cached TryKitt / Enrow credit balances per agency, pushed to the Pipeline tab
-- over Supabase Realtime. The server (pool, bypasses RLS) is the only writer:
-- pipeline batches refresh the row as they spend credits, the UI reads it.
-- refresh_claimed_at throttles provider calls across parallel workers.

BEGIN;

CREATE TABLE IF NOT EXISTS agency_provider_credits (
    agency_id          TEXT PRIMARY KEY,
    trykitt_status     TEXT NOT NULL DEFAULT 'unknown'
        CHECK (trykitt_status IN ('unknown', 'ok', 'not_configured', 'error')),
    trykitt_credits    DOUBLE PRECISION,
    trykitt_error      TEXT,
    enrow_status       TEXT NOT NULL DEFAULT 'unknown'
        CHECK (enrow_status IN ('unknown', 'ok', 'not_configured', 'error')),
    enrow_credits      DOUBLE PRECISION,
    enrow_error        TEXT,
    fetched_at         TIMESTAMPTZ,
    refresh_claimed_at TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE agency_provider_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agency_provider_credits_agency_select ON agency_provider_credits;
CREATE POLICY agency_provider_credits_agency_select
    ON agency_provider_credits
    FOR SELECT
    TO authenticated
    USING (agency_id = (SELECT current_agency_id()));

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE agency_provider_credits;
        EXCEPTION
            WHEN duplicate_object THEN NULL;
        END;
    END IF;
END $$;

COMMIT;
