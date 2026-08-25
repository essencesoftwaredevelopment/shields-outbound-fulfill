-- 0052_shopify_snapshots_job_domain_index.sql
--
-- Shopping-audit CSV export (`GET /api/jobs/:id/result`) joins contacts to
-- "does this job have any catalog snapshot for this domain?". The old shape was
-- a correlated EXISTS on shopify_snapshots keyed only by job_id.
--
-- Job 1787176188900-j7shhv (Vulcan, 7k domains) has 475k snapshot rows. With
-- idx_shopify_snapshots_job (job_id) each EXISTS nested-looped that pile, the
-- export crossed the 120s statement_timeout, and nginx returned 504.
--
-- (job_id, domain_normalized) lets the EXISTS / LATERAL LIMIT 1 probe the first
-- matching domain and stop. ANALYZE so the planner sees the new stats.

CREATE INDEX IF NOT EXISTS idx_shopify_snapshots_job_domain
    ON shopify_snapshots (job_id, domain_normalized);

ANALYZE shopify_snapshots;
