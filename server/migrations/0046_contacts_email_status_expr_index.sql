-- 0046_contacts_email_status_expr_index.sql
--
-- Every email_status filter in the leads list/export/count/delete paths compares
-- LOWER(COALESCE(email_status, '')). Without an index on that exact expression
-- the planner has no statistics for it and guesses ~0.5% selectivity (21 rows
-- where 3,826 matched on vulcan-digital), which cascaded into a nested-loop
-- re-aggregation plan and the 41 s export statement timeout.
--
-- The index gives the scan a direct probe AND gives ANALYZE an expression
-- statistics target, so row estimates come out right everywhere the predicate
-- appears. (client_id, expr) follows idx_contacts_client_email_lower: client_id
-- is globally unique per tenant, so a leading agency_id column adds nothing.

CREATE INDEX IF NOT EXISTS idx_contacts_client_email_status_lower
    ON contacts (client_id, LOWER(COALESCE(email_status, '')));

-- Populate statistics for the new index expression immediately; the fixed
-- estimates are half the point of this migration.
ANALYZE contacts;
