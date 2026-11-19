-- "Zero times / added to campaign" is a per-contact probe on
-- (contact_id, added_at) that then reads campaign_id to confirm the campaign
-- belongs to this client. idx_contact_campaigns_contact_added_at can find the
-- row, but campaign_id lives in the heap next to raw_lead_payload. On a
-- CSV export that skips everyone added in the last few days, that was one
-- wide heap fetch per skipped lead and the statement timed out.
--
-- This index answers the probe without leaving the index. It replaces
-- idx_contact_campaigns_contact_added_at, whose keys are the same prefix.
--
-- CONCURRENTLY cannot run inside a transaction: run each statement on its own,
-- not wrapped in BEGIN/COMMIT.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_campaigns_contact_added_cover
    ON contact_instantly_campaigns (contact_id, added_at DESC)
    INCLUDE (campaign_id);

DROP INDEX CONCURRENTLY IF EXISTS idx_contact_campaigns_contact_added_at;
