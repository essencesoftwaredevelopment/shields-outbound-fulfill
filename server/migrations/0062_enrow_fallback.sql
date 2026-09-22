-- 0062_enrow_fallback.sql
-- Enrow as an optional secondary email provider behind TryKitt (per agency,
-- features.enrowFallback / features.enrowVerifyRisky + agency_settings.enrow_key).
--
-- - Finder fallback: founders TryKitt found no email for are sent to Enrow's bulk
--   finder. Enrow only returns deliverable addresses, so a hit is written as
--   email_status='valid' and stamped verified (TryKitt never re-verifies it).
-- - Verifier fallback: TryKitt 'risky' / 'unknown' (catch-all) verdicts are
--   re-checked with Enrow's deterministic verifier (valid | invalid).
--
-- enrow_requests records every bulk submit: it makes a retried/resumed submit
-- reuse the in-flight Enrow batch instead of paying for it twice, and keeps the
-- true credit spend (stats.credits_cost.final) per job batch.

BEGIN;

ALTER TABLE agency_settings ADD COLUMN IF NOT EXISTS enrow_key TEXT;

-- Provenance for bounce/reply comparisons by provider. NULL = TryKitt / CSV /
-- legacy; 'enrow' = Enrow found the address / set the verdict.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_source TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_verify_source TEXT;
-- Attempt stamps (regardless of outcome), mirroring email_find_completed_at, so
-- a miss is never re-sent to Enrow within the same run.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrow_find_attempted_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrow_verify_attempted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS enrow_requests (
    id               TEXT PRIMARY KEY,               -- Enrow bulk id
    agency_id        TEXT NOT NULL,
    client_id        BIGINT,
    job_id           TEXT NOT NULL,
    batch_key        TEXT NOT NULL,                  -- child batch index, or 'all' (PM2)
    kind             TEXT NOT NULL CHECK (kind IN ('find', 'verify')),
    status           TEXT NOT NULL DEFAULT 'ongoing'
                     CHECK (status IN ('ongoing', 'applied', 'failed')),
    -- [{ contact_id, email? }] in submit order (finder results map by index/custom,
    -- verifier results only carry the email).
    items            JSONB NOT NULL DEFAULT '[]'::jsonb,
    requested        INTEGER NOT NULL DEFAULT 0,
    found            INTEGER,
    credits_initial  NUMERIC,
    credits_final    NUMERIC,
    error            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMPTZ
);

-- At most one in-flight Enrow batch per job batch + kind (idempotent submit).
CREATE UNIQUE INDEX IF NOT EXISTS ux_enrow_requests_inflight
    ON enrow_requests (job_id, batch_key, kind)
    WHERE status = 'ongoing';

CREATE INDEX IF NOT EXISTS idx_enrow_requests_agency_created
    ON enrow_requests (agency_id, created_at DESC);

-- Server-only bookkeeping (see 0049): deny-by-default, app connects BYPASSRLS.
ALTER TABLE enrow_requests ENABLE ROW LEVEL SECURITY;

COMMIT;
