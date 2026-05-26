-- 0021_extend_clients_slug.sql
-- Firestore client doc fields that were not in SQL baseline.

BEGIN;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS slug TEXT,
    ADD COLUMN IF NOT EXISTS instantly_key TEXT,
    ADD COLUMN IF NOT EXISTS industry TEXT,
    ADD COLUMN IF NOT EXISTS ntfy_topic TEXT,
    ADD COLUMN IF NOT EXISTS display_name TEXT;

-- Backfill slug as optional display/legacy hint (NOT unique; canonical id is clients.id).
UPDATE clients
SET slug = REGEXP_REPLACE(LOWER(TRIM(name)), '[^a-z0-9]+', '-', 'g')
WHERE slug IS NULL OR BTRIM(slug) = '';

CREATE INDEX IF NOT EXISTS idx_clients_agency_slug
    ON clients (agency_id, slug)
    WHERE slug IS NOT NULL AND BTRIM(slug) <> '';

COMMIT;
