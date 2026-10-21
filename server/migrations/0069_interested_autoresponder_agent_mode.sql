-- 0069_interested_autoresponder_agent_mode.sql
-- Purpose: per-prompt "free agent" mode for interested replies. When on, the
-- reply model runs a tool loop (web search, page fetch, thread, lead profile,
-- store preview) and decides for itself what to look up before submitting.
-- agent_trace records what it did (tool calls, notes for the reviewer).

BEGIN;

ALTER TABLE interested_autoresponder_prompts
    ADD COLUMN IF NOT EXISTS agent_mode BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE interested_autoresponder_drafts
    ADD COLUMN IF NOT EXISTS agent_trace JSONB;

COMMIT;
