-- Track pipeline child process for force-cancel and stale-runner reconciliation.
ALTER TABLE job_queue
    ADD COLUMN IF NOT EXISTS runner_pid INTEGER,
    ADD COLUMN IF NOT EXISTS runner_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_job_queue_runner_pid
    ON job_queue (runner_pid)
    WHERE runner_pid IS NOT NULL;
