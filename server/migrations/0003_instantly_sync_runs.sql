BEGIN;

CREATE TABLE IF NOT EXISTS instantly_sync_runs (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    trigger_source TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL,
    progress_message TEXT,
    total_campaigns INTEGER NOT NULL DEFAULT 0,
    campaigns_completed INTEGER NOT NULL DEFAULT 0,
    current_campaign_id TEXT,
    current_campaign_name TEXT,
    total_leads_seen INTEGER NOT NULL DEFAULT 0,
    matched_leads INTEGER NOT NULL DEFAULT 0,
    unmatched_leads INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instantly_sync_runs_client_started
    ON instantly_sync_runs (client_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_instantly_sync_runs_client_status
    ON instantly_sync_runs (client_id, status, updated_at DESC);

COMMIT;
