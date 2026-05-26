-- 0020_agency_settings_and_segments.sql

BEGIN;

CREATE TABLE IF NOT EXISTS agency_settings (
    agency_id TEXT PRIMARY KEY,
    openai_key TEXT,
    serper_key TEXT,
    trykitt_key TEXT,
    openai_founder_model TEXT,
    email_verification_provider TEXT DEFAULT 'trykitt',
    pricing_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
    vault_updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pricing_defaults (
    id TEXT PRIMARY KEY DEFAULT 'global',
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO pricing_defaults (id, data)
VALUES ('global', '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS client_segments (
    id TEXT NOT NULL,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    filters JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agency_id, client_id, id)
);

CREATE INDEX IF NOT EXISTS idx_client_segments_client
    ON client_segments (client_id);

COMMIT;
