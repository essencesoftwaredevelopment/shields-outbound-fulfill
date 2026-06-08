-- Calendly webhook integration: raw event log + normalized bookings.
BEGIN;

CREATE TABLE IF NOT EXISTS calendly_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    calendly_event_uuid TEXT,
    webhook_delivery_id TEXT,
    calendly_event_uri TEXT,
    invitee_uri TEXT,
    invitee_email TEXT,
    invitee_name TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_calendly_events_delivery_id
    ON calendly_events (webhook_delivery_id)
    WHERE webhook_delivery_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_calendly_events_invitee_event
    ON calendly_events (event_type, invitee_uri)
    WHERE invitee_uri IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calendly_events_email
    ON calendly_events (LOWER(invitee_email))
    WHERE invitee_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calendly_events_created_at
    ON calendly_events (created_at DESC);

CREATE TABLE IF NOT EXISTS calendly_bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scheduled_event_uri TEXT NOT NULL,
    invitee_uri TEXT,
    event_name TEXT,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    invitee_name TEXT,
    invitee_email TEXT,
    timezone TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    location TEXT,
    questions_and_answers JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw_scheduled_event JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_invitee JSONB NOT NULL DEFAULT '{}'::jsonb,
    contact_id BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
    agency_id TEXT,
    client_id BIGINT REFERENCES clients(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_calendly_bookings_scheduled_event
    ON calendly_bookings (scheduled_event_uri);

CREATE INDEX IF NOT EXISTS idx_calendly_bookings_email
    ON calendly_bookings (LOWER(invitee_email))
    WHERE invitee_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calendly_bookings_contact_id
    ON calendly_bookings (contact_id)
    WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calendly_bookings_status
    ON calendly_bookings (status);

COMMIT;
