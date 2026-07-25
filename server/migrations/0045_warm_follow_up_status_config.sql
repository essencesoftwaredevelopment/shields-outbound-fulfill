-- 0045_warm_follow_up_status_config.sql
-- Purpose: Per-client Instantly interest status applied after an interested
-- autoresponder send ("Warm Follow Up" auto-labeling).
-- - warm_follow_up_interest_value: numeric Instantly interest status value
--   (workspace-specific custom label value, e.g. 51).
-- - warm_follow_up_interest_label: label name at selection time, for display.
-- Both nullable: NULL means the post-send status update is disabled and sends
-- record a warm_follow_up_label_skipped marker event instead.

BEGIN;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS warm_follow_up_interest_value INTEGER;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS warm_follow_up_interest_label TEXT;

COMMIT;
