-- 0080_instantly_poll_reconcile.sql
-- Per-client stand-in for an Instantly webhook. A sweep on the API server
-- polls interested leads and new received mail, then runs the same draft and
-- ntfy path. The first successful pass only records who is already interested.

BEGIN;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS instantly_poll_reconcile BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS instantly_poll_seeded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS instantly_poll_last_run_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS instantly_poll_email_cursor TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS instantly_poll_last_error TEXT,
    ADD COLUMN IF NOT EXISTS instantly_poll_last_summary JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
