-- 0048_interested_reply_research.sql
-- Purpose: interested-reply research workflow (Vercel Workflows). Adds a
-- 'researching' draft status (draft shell created before the durable research
-- run promotes it to pending_review) and a research_brief JSONB column holding
-- the structured brief ({ company, domain, summary, talkingPoints, risks,
-- sources }) so it can later feed warm follow-ups / CRM notes, not just the
-- first reply.

BEGIN;

ALTER TABLE interested_autoresponder_drafts
    ADD COLUMN IF NOT EXISTS research_brief JSONB,
    ADD COLUMN IF NOT EXISTS research_completed_at TIMESTAMPTZ;

ALTER TABLE interested_autoresponder_drafts
    DROP CONSTRAINT IF EXISTS ck_interested_autoresponder_drafts_status;

ALTER TABLE interested_autoresponder_drafts
    ADD CONSTRAINT ck_interested_autoresponder_drafts_status
        CHECK (status IN (
            'researching',
            'pending_review',
            'blocked_missing_thread',
            'sent',
            'cancelled',
            'expired',
            'generation_failed'
        ));

-- 'researching' is an OPEN status: only one open draft per contact+campaign
-- thread, same invariant the inline path relied on.
DROP INDEX IF EXISTS uq_interested_autoresponder_drafts_open_thread;
CREATE UNIQUE INDEX uq_interested_autoresponder_drafts_open_thread
    ON interested_autoresponder_drafts (contact_id, campaign_id)
    WHERE status IN ('researching', 'pending_review', 'blocked_missing_thread');

COMMIT;
