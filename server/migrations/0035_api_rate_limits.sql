-- 0035_api_rate_limits.sql
-- Postgres-backed API rate limiting (replaces optional Upstash Redis).

BEGIN;

CREATE TABLE IF NOT EXISTS api_rate_limit_events (
    id BIGSERIAL PRIMARY KEY,
    scope_key TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_rate_limit_events_scope_time
    ON api_rate_limit_events (scope_key, requested_at DESC);

CREATE TABLE IF NOT EXISTS api_concurrency_leases (
    scope_key TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scope_key, lease_id)
);

CREATE INDEX IF NOT EXISTS idx_api_concurrency_leases_scope_acquired
    ON api_concurrency_leases (scope_key, acquired_at);

COMMIT;
