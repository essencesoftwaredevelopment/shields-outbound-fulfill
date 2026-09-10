-- 0055_interested_research_progress.sql
-- Purpose: surface a researching draft in pending review as soon as the
-- workflow starts, and let the UI follow the current Vercel step.
-- workflow_run_id is the Vercel wrun_ for debugging; research_step is the
-- compact progress stamp the UI polls / reads via Realtime.

BEGIN;

ALTER TABLE interested_autoresponder_drafts
    ADD COLUMN IF NOT EXISTS research_step TEXT,
    ADD COLUMN IF NOT EXISTS workflow_run_id TEXT;

COMMIT;
