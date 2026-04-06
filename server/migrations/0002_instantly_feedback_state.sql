BEGIN;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS instantly_workspace_id TEXT,
    ADD COLUMN IF NOT EXISTS instantly_webhook_id TEXT,
    ADD COLUMN IF NOT EXISTS instantly_webhook_secret TEXT,
    ADD COLUMN IF NOT EXISTS instantly_webhook_url TEXT,
    ADD COLUMN IF NOT EXISTS instantly_webhook_status INTEGER,
    ADD COLUMN IF NOT EXISTS instantly_sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS instantly_last_synced_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS instantly_last_sync_error TEXT;

ALTER TABLE instantly_campaigns
    ADD COLUMN IF NOT EXISTS status INTEGER,
    ADD COLUMN IF NOT EXISTS raw_campaign_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

ALTER TABLE contact_instantly_campaigns
    ADD COLUMN IF NOT EXISTS instantly_lead_id TEXT,
    ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lead_status INTEGER,
    ADD COLUMN IF NOT EXISTS lead_status_label TEXT,
    ADD COLUMN IF NOT EXISTS interest_status INTEGER,
    ADD COLUMN IF NOT EXISTS interest_status_label TEXT,
    ADD COLUMN IF NOT EXISTS verification_status INTEGER,
    ADD COLUMN IF NOT EXISTS email_open_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS email_reply_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS email_click_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS timestamp_last_contact TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS timestamp_last_open TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS timestamp_last_reply TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS timestamp_last_interest_change TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS timestamp_last_click TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_contacted_from TEXT,
    ADD COLUMN IF NOT EXISTS last_step_from TEXT,
    ADD COLUMN IF NOT EXISTS last_step_id TEXT,
    ADD COLUMN IF NOT EXISTS last_step_timestamp_executed TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS status_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS status_summary_subseq JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS raw_lead_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS last_reply_category TEXT,
    ADD COLUMN IF NOT EXISTS last_event_type TEXT,
    ADD COLUMN IF NOT EXISTS last_bounce_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_unsubscribe_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contact_campaigns_campaign_active
    ON contact_instantly_campaigns (campaign_id, active);

CREATE INDEX IF NOT EXISTS idx_contact_campaigns_contact_active
    ON contact_instantly_campaigns (contact_id, active);

CREATE INDEX IF NOT EXISTS idx_contact_campaigns_last_reply
    ON contact_instantly_campaigns (timestamp_last_reply DESC NULLS LAST);

CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_campaigns_campaign_lead
    ON contact_instantly_campaigns (campaign_id, instantly_lead_id)
    WHERE instantly_lead_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS contact_instantly_events (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    campaign_id BIGINT REFERENCES instantly_campaigns(id) ON DELETE SET NULL,
    instantly_campaign_id TEXT,
    instantly_lead_id TEXT,
    event_type TEXT NOT NULL,
    reply_category TEXT,
    lead_email TEXT,
    email_account TEXT,
    unibox_url TEXT,
    step INTEGER,
    variant INTEGER,
    message_text TEXT,
    event_timestamp TIMESTAMPTZ NOT NULL,
    fingerprint TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'webhook',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_instantly_events_source_fingerprint
    ON contact_instantly_events (source, fingerprint);

CREATE INDEX IF NOT EXISTS idx_contact_instantly_events_client_time
    ON contact_instantly_events (client_id, event_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_contact_instantly_events_contact_time
    ON contact_instantly_events (contact_id, event_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_contact_instantly_events_campaign_time
    ON contact_instantly_events (campaign_id, event_timestamp DESC);

CREATE TABLE IF NOT EXISTS contact_insights (
    contact_id BIGINT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
    agency_id TEXT NOT NULL,
    client_id BIGINT REFERENCES clients(id) ON DELETE CASCADE,
    annual_revenue_text TEXT,
    annual_revenue_min NUMERIC(14, 2),
    annual_revenue_max NUMERIC(14, 2),
    uses_klaviyo BOOLEAN,
    klaviyo_percent NUMERIC(5, 2),
    discovery_call_held BOOLEAN,
    last_discovery_call_at TIMESTAMPTZ,
    source TEXT,
    notes TEXT,
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_insights_client
    ON contact_insights (client_id);

CREATE INDEX IF NOT EXISTS idx_contact_insights_agency
    ON contact_insights (agency_id);

COMMIT;
