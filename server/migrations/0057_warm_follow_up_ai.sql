-- 0057_warm_follow_up_ai.sql
-- Purpose: AI-generated warm follow-ups.
-- - clients.follow_up_system_prompt: one client-level voice/CTA prompt.
-- - follow_up_scripts.step_instruction: short per-step angle (HTML templates
--   remain as last-resort fallback).
-- - follow_up_generation_runs: idempotency + UI progress for the Vercel
--   workflow (preview and autosend).

BEGIN;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS follow_up_system_prompt TEXT;

ALTER TABLE follow_up_scripts
    ADD COLUMN IF NOT EXISTS step_instruction TEXT;

CREATE TABLE IF NOT EXISTS follow_up_generation_runs (
    id                   BIGSERIAL PRIMARY KEY,
    agency_id            TEXT NOT NULL,
    client_id            BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id           BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    campaign_id         BIGINT REFERENCES instantly_campaigns(id) ON DELETE SET NULL,
    follow_up_script_id BIGINT REFERENCES follow_up_scripts(id) ON DELETE SET NULL,
    follow_up_send_id   BIGINT REFERENCES follow_up_sends(id) ON DELETE SET NULL,
    mode                 TEXT NOT NULL,
    status               TEXT NOT NULL,
    generation_step     TEXT,
    workflow_run_id     TEXT,
    rendered_subject    TEXT,
    rendered_html       TEXT,
    rendered_text       TEXT,
    used_research_brief BOOLEAN NOT NULL DEFAULT FALSE,
    research_brief      JSONB,
    used_template_fallback BOOLEAN NOT NULL DEFAULT FALSE,
    error_message        TEXT,
    sent_for_date        DATE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_follow_up_generation_runs_mode
        CHECK (mode IN ('preview', 'send')),
    CONSTRAINT ck_follow_up_generation_runs_status
        CHECK (status IN ('running', 'completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_follow_up_generation_runs_client_created
    ON follow_up_generation_runs (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_follow_up_generation_runs_status
    ON follow_up_generation_runs (id, agency_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_follow_up_generation_send_running
    ON follow_up_generation_runs (contact_id, campaign_id, sent_for_date)
    WHERE mode = 'send' AND status = 'running';

ALTER TABLE follow_up_generation_runs ENABLE ROW LEVEL SECURITY;

COMMIT;
