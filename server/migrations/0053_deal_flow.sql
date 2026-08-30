-- 0053_deal_flow.sql
-- Purpose: Deal Flow kanban tab in the client view. Interested leads are worked
-- through Interested → Follow Up → Meeting Booked → Won / Lost plus custom
-- stages, by drag and drop.
--
-- Deals own their state. contact_instantly_campaigns.interest_status is NOT
-- modified by this feature: it is only read (a) by the reconcile step that
-- creates a deal for every interested contact that has none yet, and (b) to
-- show an Instantly badge on the card when it diverges from the stage.
--
-- - deal_stages:      per-client ordered columns; exactly one is_entry column,
--                     at least one kind='won' and one kind='lost'.
-- - deals:            one row per contact per client (UNIQUE client_id, contact_id).
--                     campaign_id records the campaign that produced the interest.
-- - deal_stage_events: audit trail of stage moves (time-in-stage, conversion).
--
-- Server-only tables: RLS enabled with no policies, same as 0049. The app
-- connects as "postgres" (BYPASSRLS).

BEGIN;

CREATE TABLE IF NOT EXISTS deal_stages (
    id              BIGSERIAL PRIMARY KEY,
    agency_id       TEXT NOT NULL,
    client_id       BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    key             TEXT NOT NULL,
    name            TEXT NOT NULL,
    position        INTEGER NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'open' CHECK (kind IN ('open', 'won', 'lost')),
    color           TEXT,
    is_entry        BOOLEAN NOT NULL DEFAULT FALSE,
    instantly_interest_value INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_deal_stages_entry
    ON deal_stages (client_id) WHERE is_entry;

CREATE INDEX IF NOT EXISTS idx_deal_stages_client_position
    ON deal_stages (client_id, position);

CREATE TABLE IF NOT EXISTS deals (
    id              BIGSERIAL PRIMARY KEY,
    agency_id       TEXT NOT NULL,
    client_id       BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id      BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    campaign_id     BIGINT REFERENCES instantly_campaigns(id) ON DELETE SET NULL,
    stage_id        BIGINT NOT NULL REFERENCES deal_stages(id),
    position        DOUBLE PRECISION NOT NULL DEFAULT 0,
    notes           TEXT,
    next_action_at  TIMESTAMPTZ,
    source          TEXT NOT NULL DEFAULT 'reconcile' CHECK (source IN ('reconcile', 'manual')),
    stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at       TIMESTAMPTZ,
    archived_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_deals_client_contact
    ON deals (client_id, contact_id);

CREATE INDEX IF NOT EXISTS idx_deals_client_stage
    ON deals (client_id, stage_id, position);

CREATE TABLE IF NOT EXISTS deal_stage_events (
    id              BIGSERIAL PRIMARY KEY,
    deal_id         BIGINT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    from_stage_id   BIGINT REFERENCES deal_stages(id) ON DELETE SET NULL,
    to_stage_id     BIGINT REFERENCES deal_stages(id) ON DELETE SET NULL,
    actor           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deal_stage_events_deal
    ON deal_stage_events (deal_id, created_at);

ALTER TABLE deal_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_stage_events ENABLE ROW LEVEL SECURITY;

COMMIT;
