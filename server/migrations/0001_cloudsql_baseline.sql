-- 0001_cloudsql_baseline.sql
-- Purpose: Checked-in baseline schema for host migration and future reproducible SQL migrations.
-- Notes:
-- - This baseline is intentionally PostgreSQL-host agnostic (Cloud SQL, Supabase, etc.).
-- - client_id on companies/contacts is nullable to preserve legacy upsert paths.

BEGIN;

CREATE TABLE IF NOT EXISTS clients (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT clients_agency_name_unique UNIQUE (agency_id, name)
);

CREATE TABLE IF NOT EXISTS companies (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT REFERENCES clients(id) ON DELETE CASCADE,
    domain_normalized TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_client_domain
    ON companies (client_id, domain_normalized)
    WHERE client_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_agency_domain_legacy
    ON companies (agency_id, domain_normalized)
    WHERE client_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_companies_agency_id ON companies (agency_id);
CREATE INDEX IF NOT EXISTS idx_companies_client_id ON companies (client_id);
CREATE INDEX IF NOT EXISTS idx_companies_updated_at ON companies (updated_at DESC);

CREATE TABLE IF NOT EXISTS contacts (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT REFERENCES clients(id) ON DELETE CASCADE,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role_type TEXT NOT NULL,
    full_name TEXT,
    email TEXT,
    email_status TEXT,
    last_verified_at TIMESTAMPTZ,
    last_contacted_at TIMESTAMPTZ,
    confidence NUMERIC(5,2),
    personalization_first_line TEXT,
    job_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT contacts_company_role_unique UNIQUE (company_id, role_type)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_contacts_agency_email
    ON contacts (agency_id, LOWER(email))
    WHERE email IS NOT NULL AND BTRIM(email) <> '';

CREATE INDEX IF NOT EXISTS idx_contacts_client_id ON contacts (client_id);
CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts (company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email_status ON contacts (email_status);
CREATE INDEX IF NOT EXISTS idx_contacts_last_contacted ON contacts (last_contacted_at);
CREATE INDEX IF NOT EXISTS idx_contacts_updated_at ON contacts (updated_at DESC);

CREATE TABLE IF NOT EXISTS instantly_campaigns (
    id BIGSERIAL PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    instantly_campaign_id TEXT NOT NULL,
    name TEXT NOT NULL,
    start_date TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT instantly_campaigns_agency_client_external_unique
        UNIQUE (agency_id, client_id, instantly_campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_instantly_campaigns_client_id ON instantly_campaigns (client_id);
CREATE INDEX IF NOT EXISTS idx_instantly_campaigns_agency_id ON instantly_campaigns (agency_id);
CREATE INDEX IF NOT EXISTS idx_instantly_campaigns_start_date ON instantly_campaigns (start_date DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS contact_instantly_campaigns (
    contact_id BIGINT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    campaign_id BIGINT NOT NULL REFERENCES instantly_campaigns(id) ON DELETE CASCADE,
    upload_source TEXT NOT NULL DEFAULT 'pipeline',
    uploaded_by TEXT,
    job_id TEXT,
    notes TEXT,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (contact_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_instantly_campaigns_campaign_id
    ON contact_instantly_campaigns (campaign_id);
CREATE INDEX IF NOT EXISTS idx_contact_instantly_campaigns_job_id
    ON contact_instantly_campaigns (job_id);
CREATE INDEX IF NOT EXISTS idx_contact_instantly_campaigns_added_at
    ON contact_instantly_campaigns (added_at DESC);

CREATE TABLE IF NOT EXISTS job_stage_checkpoints (
    agency_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('founder', 'email_find', 'verify', 'personalize')),
    cursor TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (agency_id, job_id, stage)
);

CREATE INDEX IF NOT EXISTS idx_job_stage_checkpoints_agency_job
    ON job_stage_checkpoints (agency_id, job_id);

COMMIT;
