-- Partial index for the All Leads "Negative intent" activity
-- (leadActivityFilter.js: negativeIntentMatchSql). Covers Not Interested,
-- Email Bounced, Wrong Person, Unsubscribed, and Bad Fit, including the
-- title-case labels Instantly stores (e.g. "Bad Fit").
--
-- Lookups are (agency_id, client_id, contact_id) with an optional
-- event_timestamp window. The WHERE clause is the same predicate the filter
-- emits, so Postgres can use this index for "zero times" / "at least once".
--
-- CONCURRENTLY cannot run inside a transaction: run this file as a single
-- statement, not wrapped in BEGIN/COMMIT.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contact_instantly_events_negative_intent
    ON contact_instantly_events (agency_id, client_id, contact_id, event_timestamp DESC)
    WHERE contact_id IS NOT NULL
      AND (LOWER(COALESCE(event_type, '')) LIKE '%bounce%' OR event_type = ANY(ARRAY['Bad Fit', 'Lead Not Interested', 'Lead Unsubscribed', 'Lead Wrong Person', 'Not Interested', 'bad fit', 'bad_fit', 'lead not interested', 'lead unsubscribed', 'lead wrong person', 'lead_not_interested', 'lead_unsubscribed', 'lead_wrong_person', 'not interested', 'not_interested']::text[]));
