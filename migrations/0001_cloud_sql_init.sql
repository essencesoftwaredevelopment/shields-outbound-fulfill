-- Cloud SQL initial schema for batched, resumable pipeline

create table if not exists companies (
    id bigserial primary key,
    client_id text not null,
    domain_normalized text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (client_id, domain_normalized)
);

create table if not exists contacts (
    id bigserial primary key,
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
    unique (company_id, role_type),
    unique (email)
);

create table if not exists job_stage_checkpoints (
    job_id text not null,
    stage text not null check (stage in ('founder', 'email_find', 'verify', 'personalize')),
    cursor text not null,
    updated_at timestamptz not null default now(),
    primary key (job_id, stage)
);

create index if not exists idx_companies_client_domain on companies (client_id, domain_normalized);
create index if not exists idx_contacts_company_role on contacts (company_id, role_type);
create index if not exists idx_contacts_email_status on contacts (email_status);
create index if not exists idx_contacts_updated_at on contacts (updated_at desc);
