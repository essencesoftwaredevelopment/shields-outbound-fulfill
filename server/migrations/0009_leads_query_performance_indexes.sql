BEGIN;

CREATE INDEX IF NOT EXISTS idx_contacts_agency_company
    ON contacts (agency_id, company_id);

CREATE INDEX IF NOT EXISTS idx_instantly_campaigns_agency_client_id
    ON instantly_campaigns (agency_id, client_id, id);

CREATE INDEX IF NOT EXISTS idx_contact_campaigns_contact_added_at
    ON contact_instantly_campaigns (contact_id, added_at DESC);

COMMIT;
