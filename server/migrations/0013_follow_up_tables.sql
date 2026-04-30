-- 0013_follow_up_tables.sql
-- Purpose: Add automated follow-up sender schema.
-- - reply_to_uuid column on contact_instantly_events to capture Instantly email UUID for thread replies.
-- - follow_up_scripts: client-scoped ordered template library.
-- - follow_up_sends: immutable audit/idempotency log enforcing at-most-one-success per prospect per day.
-- - Indexes to support warm-follow-up eligibility query pattern.

BEGIN;

-- ─── contact_instantly_events: capture email UUID needed by Instantly reply endpoint ───

ALTER TABLE contact_instantly_events
    ADD COLUMN IF NOT EXISTS reply_to_uuid TEXT;

CREATE INDEX IF NOT EXISTS idx_contact_instantly_events_reply_uuid
    ON contact_instantly_events (contact_id, campaign_id, reply_to_uuid)
    WHERE reply_to_uuid IS NOT NULL;

-- Fast lookup: latest Warm Follow Up anchor per contact+campaign
CREATE INDEX IF NOT EXISTS idx_contact_instantly_events_warmfu_anchor
    ON contact_instantly_events (contact_id, campaign_id, event_timestamp DESC)
    WHERE event_type = 'Warm Follow Up';

-- Fast lookup: blocker events per contact+campaign (used in NOT EXISTS sub-query)
CREATE INDEX IF NOT EXISTS idx_contact_instantly_events_blocker_type
    ON contact_instantly_events (contact_id, campaign_id, event_type, event_timestamp DESC);

-- ─── follow_up_scripts ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS follow_up_scripts (
    id              BIGSERIAL PRIMARY KEY,
    client_id       BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    script_order    INTEGER NOT NULL DEFAULT 1,
    name            TEXT,
    subject_template TEXT NOT NULL,
    html_template    TEXT NOT NULL,
    text_template    TEXT,
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_follow_up_scripts_client_order UNIQUE (client_id, script_order)
);

CREATE INDEX IF NOT EXISTS idx_follow_up_scripts_client_active
    ON follow_up_scripts (client_id, active, script_order)
    WHERE active = TRUE;

-- ─── follow_up_sends ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS follow_up_sends (
    id                   BIGSERIAL PRIMARY KEY,
    client_id            BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id           BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    company_id           BIGINT REFERENCES companies(id) ON DELETE SET NULL,
    campaign_id          BIGINT REFERENCES instantly_campaigns(id) ON DELETE SET NULL,
    follow_up_script_id  BIGINT REFERENCES follow_up_scripts(id) ON DELETE SET NULL,

    -- Instantly identifiers used at send time
    instantly_lead_id    TEXT,
    reply_to_uuid        TEXT,
    eaccount             TEXT,

    -- Rendered payload snapshot (immutable after insert)
    rendered_subject     TEXT,
    rendered_html        TEXT,
    rendered_text        TEXT,

    -- Outcome
    status               TEXT NOT NULL DEFAULT 'pending',
    -- Valid values: pending | sent | failed_retryable | failed_permanent | blocked_missing_thread
    error_code           TEXT,
    error_message        TEXT,
    retryable            BOOLEAN NOT NULL DEFAULT FALSE,

    -- Calendar date the send was attempted for (client timezone, set by worker)
    sent_for_date        DATE NOT NULL,

    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce at-most-one successful send per contact+campaign+script per calendar day
CREATE UNIQUE INDEX IF NOT EXISTS uq_follow_up_sends_success_daily
    ON follow_up_sends (contact_id, campaign_id, follow_up_script_id, sent_for_date)
    WHERE status = 'sent';

-- Support eligibility recheck: find any successful send today
CREATE INDEX IF NOT EXISTS idx_follow_up_sends_contact_campaign_date
    ON follow_up_sends (contact_id, campaign_id, sent_for_date, status);

-- Retry queue: find pending/retryable rows for a given date
CREATE INDEX IF NOT EXISTS idx_follow_up_sends_pending
    ON follow_up_sends (client_id, sent_for_date, status)
    WHERE status IN ('pending', 'failed_retryable');

COMMIT;
