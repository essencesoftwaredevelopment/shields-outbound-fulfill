-- 0058_follow_up_ai_opt_in.sql
-- Purpose: AI warm follow-ups are opt-in per client. Default off so existing
-- static HTML/text scripts keep sending unchanged until a client switches.

BEGIN;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS follow_up_ai_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
