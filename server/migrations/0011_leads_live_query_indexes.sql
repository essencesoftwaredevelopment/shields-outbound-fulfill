BEGIN;

CREATE INDEX IF NOT EXISTS idx_contacts_agency_client_id
    ON contacts (agency_id, client_id);

CREATE INDEX IF NOT EXISTS idx_companies_agency_client_id_id
    ON companies (agency_id, client_id, id);

CREATE INDEX IF NOT EXISTS idx_contact_campaigns_campaign_contact_added_at
    ON contact_instantly_campaigns (campaign_id, contact_id, added_at DESC);

COMMIT;
