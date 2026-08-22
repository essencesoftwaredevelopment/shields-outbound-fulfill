-- Store meeting start time from Calendly payload.scheduled_event.start_time
-- as a first-class column on webhook ingest, and backfill existing rows.
BEGIN;

ALTER TABLE calendly_events
    ADD COLUMN IF NOT EXISTS start_time TIMESTAMPTZ;

-- Standard webhook shape: { event, payload: { scheduled_event: { start_time } } }
-- Fallback: inner payload stored at the top level.
UPDATE calendly_events
SET start_time = COALESCE(
    NULLIF(payload #>> '{payload,scheduled_event,start_time}', ''),
    NULLIF(payload #>> '{scheduled_event,start_time}', '')
)::timestamptz
WHERE start_time IS NULL
  AND COALESCE(
        NULLIF(payload #>> '{payload,scheduled_event,start_time}', ''),
        NULLIF(payload #>> '{scheduled_event,start_time}', '')
      ) IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calendly_events_start_time
    ON calendly_events (start_time)
    WHERE start_time IS NOT NULL;

COMMIT;
