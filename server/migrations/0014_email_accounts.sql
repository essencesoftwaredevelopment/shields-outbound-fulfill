-- 0014_email_accounts.sql
-- Purpose: Store Instantly email account metadata per client, including
-- account signatures for follow-up rendering.

BEGIN;

CREATE TABLE IF NOT EXISTS email_accounts (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    provider_code INTEGER,
    signature TEXT,
    instantly_workspace_id TEXT,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT email_accounts_client_email_unique UNIQUE (client_id, email)
);

CREATE INDEX IF NOT EXISTS idx_email_accounts_agency_id ON email_accounts (agency_id);
CREATE INDEX IF NOT EXISTS idx_email_accounts_client_id ON email_accounts (client_id);
CREATE INDEX IF NOT EXISTS idx_email_accounts_last_synced_at ON email_accounts (last_synced_at DESC NULLS LAST);

COMMIT;
