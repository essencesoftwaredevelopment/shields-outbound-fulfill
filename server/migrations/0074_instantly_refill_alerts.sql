-- 0074_instantly_refill_alerts.sql
-- ntfy alerts for the automatic Instantly refill (services/instantlyRefillAlerts.js).
-- Per-client state of the issues currently alerting, so the same problem is
-- not re-sent on every run and a "resolved" message goes out when it clears:
--   { "<issue key>": { "since": ts, "notifiedAt": ts, "headline": text,
--                      "severity": "critical"|"warning", "scope": "run"|"watchdog" } }

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS instantly_refill_alerts JSONB NOT NULL DEFAULT '{}'::jsonb;
