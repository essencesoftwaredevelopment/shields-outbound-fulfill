-- Speeds up job-scoped contact lookups (finalization counts, downloads, resume diagnostics).
CREATE INDEX IF NOT EXISTS idx_contacts_job_id
    ON contacts (job_id)
    WHERE job_id IS NOT NULL;
