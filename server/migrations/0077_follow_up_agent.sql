-- 0077_follow_up_agent.sql
-- Purpose: per-client follow-up agent. When on (and live follow-ups are on AI),
-- each touch runs a tool loop (web search, page fetch, thread, lead profile,
-- store preview) and sends without human review. Off by default for everyone.
-- - follow_up_agent_max_touches / follow_up_agent_min_gap_days: the cadence
--   (12 touches, 2 send days apart is about 4 weeks on weekdays).
-- - agent_trace / agent_outcome: what the agent did and decided on each run.

BEGIN;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS follow_up_agent_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS follow_up_agent_max_touches INTEGER NOT NULL DEFAULT 12,
    ADD COLUMN IF NOT EXISTS follow_up_agent_min_gap_days INTEGER NOT NULL DEFAULT 2;

ALTER TABLE follow_up_generation_runs
    ADD COLUMN IF NOT EXISTS agent_trace JSONB,
    ADD COLUMN IF NOT EXISTS agent_outcome TEXT;

ALTER TABLE follow_up_generation_runs
    DROP CONSTRAINT IF EXISTS ck_follow_up_generation_runs_agent_outcome;
ALTER TABLE follow_up_generation_runs
    ADD CONSTRAINT ck_follow_up_generation_runs_agent_outcome
    CHECK (agent_outcome IS NULL OR agent_outcome IN ('send', 'skip', 'end', 'blocked'));

COMMIT;
