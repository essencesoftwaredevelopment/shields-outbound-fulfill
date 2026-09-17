-- 0060_jobs_replica_identity_full.sql
-- Realtime UPDATE payloads for `jobs` omit unchanged TOASTed JSONB columns
-- (`options`, `stages`, `dedupe_stats`) under the default replica identity —
-- e.g. the 30s child heartbeat `UPDATE jobs SET updated_at = NOW()` arrives
-- without `options`, the client reads every skip flag as false and the hidden
-- Founder/Email cards flicker in with the wrong copy. REPLICA IDENTITY FULL
-- logs the whole row so every payload carries every column. The table is
-- small (one row per job) so the extra WAL is negligible.
--
-- Same fix as 0056 for interested_autoresponder_drafts. The client also
-- tolerates partial payloads now (lib/pipeline/realtimeRow.ts), so this is
-- belt and braces.

ALTER TABLE jobs REPLICA IDENTITY FULL;
