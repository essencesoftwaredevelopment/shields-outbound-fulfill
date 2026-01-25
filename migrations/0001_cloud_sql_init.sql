-- Cloud SQL initial schema for multi-tenant, batched, resumable pipeline
--
-- CANONICAL AGENCY IDENTIFIER RULE:
-- The Firestore users/{uid} document ID is the canonical agency identifier.
-- This same Firebase Auth uid is used directly as agency_id in all Cloud SQL tables.
-- No reconciliation or mapping is required.
--
-- MVP SCOPE: Single implicit client per agency
-- In the current MVP, there is no clients table.
-- All lead data (companies, contacts) is scoped directly to agency_id.
-- This means: one agency = one implicit client.
--
-- FUTURE EVOLUTION (not in MVP):
-- A clients table will be introduced with:
--   - id (unique per agency)
--   - agency_id (auth boundary)
--   - client metadata (brand name, domain, etc.)
-- At that point:
--   - companies will add: client_id NOT NULL, FOREIGN KEY (agency_id, client_id)
--   - contacts will add: client_id NOT NULL (denormalized from company)
--   - Queries will filter by BOTH agency_id AND client_id
--   - Access control will still be enforced via agency_id only
--
-- DESIGN INVARIANT:
--   - agency_id is always the AUTH boundary
--   - client_id is a logical PRODUCT subdivision within an agency
--   - This separation ensures future client support is transparent to auth layer

-- Table 1: companies
-- Stores one row per unique company domain per agency.
-- Root entity for deduplication and joining contacts to a company.
create table if not exists companies (
    id bigserial primary key,
    agency_id text not null,
    domain_normalized text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- Core dedupe guarantee: one domain per agency
    unique (agency_id, domain_normalized)
);

-- Table 2: contacts
-- Stores one row per "contact slot" (person + email combined) per company.
-- Source of truth for "who have we found", "what's their email status", "have we contacted them recently".
create table if not exists contacts (
    id bigserial primary key,
    agency_id text not null,
    company_id bigint not null references companies(id) on delete cascade,
    role_type text not null check (role_type in ('founder', 'dm')),
    full_name text,
    email text,
    email_status text check (email_status in ('valid', 'risky', 'invalid', 'unknown')),
    last_verified_at timestamptz,
    last_contacted_at timestamptz,
    confidence numeric(5,2),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    -- Ensures only one slot per role per company (idempotent reruns)
    unique (company_id, role_type),
    -- Email uniqueness per agency (prevent internal duplicates)
    -- Different agencies can have same email (tenant isolation)
    unique (agency_id, email) where email is not null
);

-- Table 3: job_stage_checkpoints
-- Stores resumable progress for each pipeline stage.
-- Crash-safety layer for long-running, CSV-based processing.
create table if not exists job_stage_checkpoints (
    agency_id text not null,
    job_id text not null,
    stage text not null check (stage in ('founder', 'email_find', 'verify', 'personalize')),
    cursor text not null,
    updated_at timestamptz not null default now(),
    primary key (agency_id, job_id, stage)
);

-- Indexes for common query patterns

-- Support fast domain lookup per agency
create index if not exists idx_companies_agency_domain on companies (agency_id, domain_normalized);

-- Support fast contact lookup by company and role
create index if not exists idx_contacts_company_role on contacts (company_id, role_type);

-- Support "exclude recently contacted" and send-safety queries
create index if not exists idx_contacts_agency_contacted on contacts (agency_id, last_contacted_at);

-- Support filtering by email status
create index if not exists idx_contacts_email_status on contacts (email_status);

-- Support timeline queries
create index if not exists idx_contacts_updated_at on contacts (updated_at desc);

-- Support job progress lookups
create index if not exists idx_job_checkpoints_agency_job on job_stage_checkpoints (agency_id, job_id);
