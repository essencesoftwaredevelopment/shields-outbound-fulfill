-- Analytics query patterns for contact_instantly_events:
--   (agency_id, client_id, event_timestamp) for period scans
--   (client_id, event_type, event_timestamp) for lead_interested lifecycle lookups

CREATE INDEX IF NOT EXISTS idx_contact_instantly_events_agency_client_time
    ON contact_instantly_events (agency_id, client_id, event_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_contact_instantly_events_client_type_time
    ON contact_instantly_events (client_id, event_type, event_timestamp DESC);
