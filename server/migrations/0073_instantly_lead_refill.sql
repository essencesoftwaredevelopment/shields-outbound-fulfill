-- 0073_instantly_lead_refill.sql
-- Automatic refill of one Instantly campaign from the lead bank, so the inboxes
-- never sit idle for lack of new prospects. Per-client opt-in on the Info tab.
-- Each run tops the campaign's never-contacted backlog up to N sending days of
-- new-lead capacity with valid leads not emailed in `cooldown_days`, oldest
-- first, re-verifying stale emails before adding (services/instantlyRefill.js).
-- Adds are recorded in contact_instantly_campaigns with upload_source 'auto_refill'.

BEGIN;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS instantly_refill_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS instantly_refill_campaign_id TEXT,
    ADD COLUMN IF NOT EXISTS instantly_refill_cooldown_days INTEGER NOT NULL DEFAULT 90
        CHECK (instantly_refill_cooldown_days BETWEEN 30 AND 365),
    ADD COLUMN IF NOT EXISTS instantly_refill_backlog_days INTEGER NOT NULL DEFAULT 2
        CHECK (instantly_refill_backlog_days BETWEEN 1 AND 5),
    ADD COLUMN IF NOT EXISTS instantly_refill_last_run_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS instantly_refill_runs (
    id                    BIGSERIAL PRIMARY KEY,
    agency_id             TEXT NOT NULL,
    client_id             BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    instantly_campaign_id TEXT NOT NULL,
    trigger_source        TEXT NOT NULL DEFAULT 'scheduled',
    status                TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'failed')),
    summary               JSONB NOT NULL DEFAULT '{}'::jsonb,
    error                 TEXT,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_instantly_refill_runs_client
    ON instantly_refill_runs (client_id, started_at DESC);

-- Server-only table (pool bypasses RLS); nothing reads it from the browser.
ALTER TABLE instantly_refill_runs ENABLE ROW LEVEL SECURITY;

ALTER TABLE contact_instantly_campaigns
    DROP CONSTRAINT IF EXISTS contact_instantly_campaigns_upload_source_check;

ALTER TABLE contact_instantly_campaigns
    ADD CONSTRAINT contact_instantly_campaigns_upload_source_check
    CHECK (
        upload_source = ANY (
            ARRAY[
                'pipeline'::text,
                'manual'::text,
                'instantly_sync'::text,
                'instantly_webhook'::text,
                'auto_refill'::text
            ]
        )
    );

COMMIT;
