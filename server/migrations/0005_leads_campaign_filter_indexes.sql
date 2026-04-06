BEGIN;

CREATE INDEX IF NOT EXISTS idx_contact_campaigns_campaign_active_contact
    ON contact_instantly_campaigns (campaign_id, active, contact_id);

CREATE INDEX IF NOT EXISTS idx_contacts_agency_created_at
    ON contacts (agency_id, created_at DESC);

COMMIT;
