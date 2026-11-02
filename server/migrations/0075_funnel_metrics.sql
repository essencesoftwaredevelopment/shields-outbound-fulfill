-- 0075_funnel_metrics.sql
-- Metrics tab: one funnel from sending to cash. Sending and reply numbers are
-- computed from Instantly + contact_instantly_events; these two tables hold the
-- sales and money inputs that aren't captured anywhere else.
--
-- - sales_calls:    one row per sales call / deal. Calendly bookings for the
--                   client are added automatically (calendly_booking_id); rows
--                   can also be added by hand (e.g. existing retainer clients).
--                   Drives booking/show/qualified/proposal/close rates, days to
--                   close, stalled deals, lost reasons, revenue, churn and LTV.
-- - outreach_costs: recurring monthly cost lines (inboxes, domains, tools,
--                   leads). Enrichment spend from job_stage_costs is added on
--                   top automatically, so don't enter it here as well.
--
-- Server-only tables: RLS enabled with no policies. The app connects as
-- "postgres" (BYPASSRLS).

BEGIN;

CREATE TABLE IF NOT EXISTS sales_calls (
    id                  BIGSERIAL PRIMARY KEY,
    agency_id           TEXT NOT NULL,
    client_id           BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id          BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    calendly_booking_id UUID UNIQUE REFERENCES calendly_bookings(id) ON DELETE SET NULL,
    company             TEXT,
    contact_name        TEXT,
    contact_email       TEXT,
    booked_at           TIMESTAMPTZ,
    call_at             TIMESTAMPTZ,
    call_status         TEXT NOT NULL DEFAULT 'booked'
        CHECK (call_status IN ('booked', 'held', 'no_show', 'canceled')),
    qualified           BOOLEAN,
    proposal_sent_on    DATE,
    outcome             TEXT NOT NULL DEFAULT 'open'
        CHECK (outcome IN ('open', 'won', 'lost')),
    closed_on           DATE,
    lost_reason         TEXT
        CHECK (lost_reason IN ('price', 'timing', 'competitor', 'no_budget', 'ghosted', 'not_a_fit')),
    build_value         NUMERIC(12, 2) CHECK (build_value >= 0),
    retainer_monthly    NUMERIC(12, 2) CHECK (retainer_monthly >= 0),
    retainer_start      DATE,
    retainer_end        DATE,
    last_contact_on     DATE,
    next_follow_up_on   DATE,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_calls_client_booked
    ON sales_calls (client_id, booked_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_calls_client_call
    ON sales_calls (client_id, call_at DESC);

CREATE TABLE IF NOT EXISTS outreach_costs (
    id              BIGSERIAL PRIMARY KEY,
    agency_id       TEXT NOT NULL,
    client_id       BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    label           TEXT NOT NULL,
    category        TEXT NOT NULL DEFAULT 'other'
        CHECK (category IN ('inboxes', 'domains', 'tools', 'leads', 'other')),
    monthly_amount  NUMERIC(12, 2) NOT NULL CHECK (monthly_amount >= 0),
    starts_on       DATE NOT NULL DEFAULT CURRENT_DATE,
    ends_on         DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS idx_outreach_costs_client
    ON outreach_costs (client_id, starts_on);

ALTER TABLE sales_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_costs ENABLE ROW LEVEL SECURITY;

COMMIT;
