-- Fix Calendly timeline events: use booking time (not meeting start time) and align event type with analytics.
BEGIN;

-- Align event type with Instantly convention so client analytics counts Calendly bookings.
UPDATE contact_instantly_events
SET event_type = 'lead_meeting_booked'
WHERE source = 'calendly'
  AND LOWER(event_type) = 'meeting_booked';

-- Backfill booking timestamps from Calendly invitee.created_at when event_timestamp was the meeting start time.
UPDATE contact_instantly_events cie
SET event_timestamp = COALESCE(
    NULLIF(cie.payload->'raw'->'payload'->>'created_at', '')::timestamptz,
    NULLIF(cie.payload->'raw'->>'created_at', '')::timestamptz,
    cie.created_at
)
WHERE cie.source = 'calendly'
  AND LOWER(cie.event_type) IN ('meeting_booked', 'lead_meeting_booked')
  AND cie.payload->>'start_time' IS NOT NULL
  AND DATE_TRUNC('second', cie.event_timestamp) = DATE_TRUNC('second', (cie.payload->>'start_time')::timestamptz);

-- Backfill cancellation timestamps from Calendly invitee.updated_at when event_timestamp was the meeting start time.
UPDATE contact_instantly_events cie
SET event_timestamp = COALESCE(
    NULLIF(cie.payload->'raw'->'payload'->>'updated_at', '')::timestamptz,
    NULLIF(cie.payload->'raw'->>'created_at', '')::timestamptz,
    cie.created_at
)
WHERE cie.source = 'calendly'
  AND LOWER(cie.event_type) = 'meeting_canceled'
  AND cie.payload->>'start_time' IS NOT NULL
  AND DATE_TRUNC('second', cie.event_timestamp) = DATE_TRUNC('second', (cie.payload->>'start_time')::timestamptz);

COMMIT;
