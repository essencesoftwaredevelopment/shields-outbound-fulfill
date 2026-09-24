-- 0066_instantly_lead_cleanup.sql
-- Automatic deletion of finished leads from Instantly (frees the workspace's
-- lead allowance). Per-client opt-in, configured on the client Info tab.
-- Every run syncs the affected campaigns and backfills their replies first, so
-- our copy (contacts, contact_instantly_campaigns, contact_instantly_events) is
-- complete before Instantly forgets the lead; deleted memberships are kept here
-- as active = false / removed_at, notes 'auto_cleanup:<category>'.

BEGIN;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS instantly_cleanup_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS instantly_cleanup_days INTEGER NOT NULL DEFAULT 7
        CHECK (instantly_cleanup_days BETWEEN 1 AND 365),
    ADD COLUMN IF NOT EXISTS instantly_cleanup_last_run_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS instantly_cleanup_runs (
    id            BIGSERIAL PRIMARY KEY,
    agency_id     TEXT NOT NULL,
    client_id     BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    trigger_source TEXT NOT NULL DEFAULT 'scheduled',
    status        TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'failed')),
    days          INTEGER NOT NULL,
    summary       JSONB NOT NULL DEFAULT '{}'::jsonb,
    error         TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_instantly_cleanup_runs_client
    ON instantly_cleanup_runs (client_id, started_at DESC);

-- Server-only table (pool bypasses RLS); nothing reads it from the browser.
ALTER TABLE instantly_cleanup_runs ENABLE ROW LEVEL SECURITY;

-- Backfill dedupe: replies are matched on Instantly's email id.
CREATE INDEX IF NOT EXISTS idx_contact_instantly_events_reply_uuid
    ON contact_instantly_events (reply_to_uuid)
    WHERE reply_to_uuid IS NOT NULL;

COMMIT;
