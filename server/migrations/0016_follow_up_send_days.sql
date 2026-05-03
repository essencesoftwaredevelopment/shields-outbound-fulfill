-- 0016_follow_up_send_days.sql
--
-- Add configurable send-day schedule to clients.
-- Values are DOW integers matching JavaScript's Date.getUTCDay(): 0=Sun, 1=Mon, …, 6=Sat.
-- Default: weekdays only {1,2,3,4,5}.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS follow_up_send_days INT[] NOT NULL DEFAULT '{1,2,3,4,5}';
