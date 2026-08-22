-- Covering index for outreach analytics (emails sent / interested / meetings).
-- Filters are (agency_id, client_id, event_type, event_timestamp); INCLUDE(contact_id)
-- lets COUNT(*) and unique-contact hashes stay index-only.

CREATE INDEX IF NOT EXISTS idx_contact_instantly_events_agency_client_type_time
    ON contact_instantly_events (agency_id, client_id, event_type, event_timestamp DESC)
    INCLUDE (contact_id);
