-- 0019_jobs_pipeline_tables.sql
-- Pipeline orchestration: jobs, domain queue, Serper cache, worker queue.

BEGIN;

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    agency_id TEXT NOT NULL,
    client_id BIGINT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    client_slug TEXT NOT NULL,
    job_type TEXT NOT NULL DEFAULT 'pipeline',
    status TEXT NOT NULL DEFAULT 'queued',
    paused BOOLEAN NOT NULL DEFAULT FALSE,
    cancelled BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    file_name TEXT,
    error TEXT,
    cost NUMERIC(12, 6) NOT NULL DEFAULT 0,
    stages JSONB NOT NULL DEFAULT '{}'::jsonb,
    logs JSONB NOT NULL DEFAULT '[]'::jsonb,
    options JSONB NOT NULL DEFAULT '{}'::jsonb,
    dedupe_stats JSONB,
    upload_status TEXT,
    upload_error TEXT,
    upload_metrics JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    paused_at TIMESTAMPTZ,
    resumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_agency_client_status
    ON jobs (agency_id, client_id, status);

CREATE INDEX IF NOT EXISTS idx_jobs_agency_created_at
    ON jobs (agency_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_one_active_per_client
    ON jobs (client_id)
    WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS job_domains (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    agency_id TEXT NOT NULL,
    domain_normalized TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'done', 'skipped')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    raw_row JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job_id, domain_normalized)
);

CREATE INDEX IF NOT EXISTS idx_job_domains_job_status
    ON job_domains (job_id, status);

CREATE INDEX IF NOT EXISTS idx_job_domains_job_sort
    ON job_domains (job_id, sort_order);

CREATE TABLE IF NOT EXISTS job_serper_cache (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    domain_normalized TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (job_id, domain_normalized)
);

CREATE TABLE IF NOT EXISTS job_queue (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    agency_id TEXT NOT NULL,
    client_slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    control JSONB NOT NULL DEFAULT '{"paused":false,"cancelled":false}'::jsonb,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_by TEXT,
    claimed_at TIMESTAMPTZ,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_queue_status_enqueued
    ON job_queue (status, enqueued_at);

COMMIT;
