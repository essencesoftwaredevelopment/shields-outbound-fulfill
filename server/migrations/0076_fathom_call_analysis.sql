-- 0076_fathom_call_analysis.sql
-- Fathom call recordings → AI analysis → sales log (Metrics tab).
--
-- Saving a Fathom API key in the API vault registers a Fathom webhook for the
-- agency (fathom_webhook_id / fathom_webhook_secret) and backfills recent
-- recordings. Each recording becomes a call_recordings row, then the
-- call-analysis workflow (workflows/call-analysis.ts):
--   match   — the recording's external attendees → a sales_calls row
--             (email, then company domain, then a contact with a positive
--             reply, which creates the sales call). No match → 'unmatched'
--             (team meetings, client calls) and no AI cost.
--   analyze — one model call on the transcript → structured JSON (analysis).
--   apply   — fills sales_calls fields. A field the user set by hand is never
--             overwritten: sales_calls.ai_filled_fields lists the fields the AI
--             wrote, and a manual edit removes the field from that list.
--
-- Server-only tables: RLS enabled with no policies (app connects as postgres).

BEGIN;

ALTER TABLE agency_settings ADD COLUMN IF NOT EXISTS fathom_key TEXT;
ALTER TABLE agency_settings ADD COLUMN IF NOT EXISTS fathom_webhook_id TEXT;
ALTER TABLE agency_settings ADD COLUMN IF NOT EXISTS fathom_webhook_secret TEXT;

ALTER TABLE sales_calls ADD COLUMN IF NOT EXISTS ai_filled_fields TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE sales_calls ADD COLUMN IF NOT EXISTS ai_summary TEXT;
ALTER TABLE sales_calls ADD COLUMN IF NOT EXISTS ai_updated_at TIMESTAMPTZ;
-- Recording time of the newest recording applied; an older recording analysed
-- later (backfill order) only fills empty fields.
ALTER TABLE sales_calls ADD COLUMN IF NOT EXISTS ai_source_recorded_at TIMESTAMPTZ;
ALTER TABLE sales_calls ADD COLUMN IF NOT EXISTS recording_url TEXT;

CREATE TABLE IF NOT EXISTS call_recordings (
    id                  BIGSERIAL PRIMARY KEY,
    agency_id           TEXT NOT NULL,
    client_id           BIGINT REFERENCES clients(id) ON DELETE CASCADE,
    sales_call_id       BIGINT REFERENCES sales_calls(id) ON DELETE SET NULL,
    provider            TEXT NOT NULL DEFAULT 'fathom',
    external_id         TEXT NOT NULL,
    title               TEXT,
    url                 TEXT,
    share_url           TEXT,
    recorded_at         TIMESTAMPTZ,
    recording_end_at    TIMESTAMPTZ,
    recorded_by_email   TEXT,
    external_emails     TEXT[] NOT NULL DEFAULT '{}',
    invitees            JSONB NOT NULL DEFAULT '[]'::jsonb,
    transcript          TEXT,
    provider_summary    TEXT,
    status              TEXT NOT NULL DEFAULT 'received'
        CHECK (status IN ('received', 'unmatched', 'matched', 'analyzed', 'applied', 'failed')),
    match_reason        TEXT,
    analysis            JSONB,
    applied_fields      TEXT[] NOT NULL DEFAULT '{}',
    error               TEXT,
    workflow_run_id     TEXT,
    analyzed_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (agency_id, provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_call_recordings_sales_call
    ON call_recordings (sales_call_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_recordings_agency_status
    ON call_recordings (agency_id, status, recorded_at DESC);

ALTER TABLE call_recordings ENABLE ROW LEVEL SECURITY;

COMMIT;
