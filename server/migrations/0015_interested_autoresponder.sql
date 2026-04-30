-- 0015_interested_autoresponder.sql
-- Purpose: store campaign-scoped AI responder prompts and generated reviewer drafts
-- for interested leads, with one active prompt per campaign and one open draft per
-- contact+campaign thread.

BEGIN;

CREATE TABLE IF NOT EXISTS interested_autoresponder_prompts (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    campaign_id BIGINT NOT NULL REFERENCES instantly_campaigns(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_interested_autoresponder_prompts_campaign_active
    ON interested_autoresponder_prompts (campaign_id)
    WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_interested_autoresponder_prompts_client_campaign
    ON interested_autoresponder_prompts (client_id, campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS interested_autoresponder_drafts (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    campaign_id BIGINT NOT NULL REFERENCES instantly_campaigns(id) ON DELETE CASCADE,
    contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    instantly_lead_id TEXT,
    source_event_id BIGINT REFERENCES contact_instantly_events(id) ON DELETE SET NULL,
    review_token TEXT,
    review_token_expires_at TIMESTAMPTZ,
    status TEXT NOT NULL,
    blocked_reason TEXT,
    reply_to_uuid TEXT,
    eaccount TEXT,
    thread_subject TEXT,
    lead_email TEXT NOT NULL,
    previous_lead_message TEXT,
    system_prompt_version TEXT NOT NULL,
    model TEXT NOT NULL,
    rendered_text TEXT,
    sent_event_id BIGINT REFERENCES contact_instantly_events(id) ON DELETE SET NULL,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_interested_autoresponder_drafts_status
        CHECK (status IN ('pending_review', 'blocked_missing_thread', 'sent', 'cancelled', 'expired', 'generation_failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_interested_autoresponder_drafts_review_token
    ON interested_autoresponder_drafts (review_token)
    WHERE review_token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_interested_autoresponder_drafts_open_thread
    ON interested_autoresponder_drafts (contact_id, campaign_id)
    WHERE status IN ('pending_review', 'blocked_missing_thread');

CREATE INDEX IF NOT EXISTS idx_interested_autoresponder_drafts_client_status
    ON interested_autoresponder_drafts (client_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_interested_autoresponder_drafts_token_expiry
    ON interested_autoresponder_drafts (review_token_expires_at)
    WHERE review_token IS NOT NULL;

COMMIT;
