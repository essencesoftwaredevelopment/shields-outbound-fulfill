-- 0079_outreach_cost_cadence.sql
-- Purpose: outreach costs are either monthly (count every month, no dates) or
-- one-time (count toward one month). starts_on / ends_on are no longer used.
-- Existing rows become monthly.

BEGIN;

ALTER TABLE outreach_costs
    ADD COLUMN IF NOT EXISTS cadence TEXT NOT NULL DEFAULT 'monthly',
    ADD COLUMN IF NOT EXISTS cost_month DATE;

ALTER TABLE outreach_costs DROP CONSTRAINT IF EXISTS outreach_costs_cadence_check;
ALTER TABLE outreach_costs
    ADD CONSTRAINT outreach_costs_cadence_check CHECK (cadence IN ('monthly', 'one_time'));

ALTER TABLE outreach_costs DROP CONSTRAINT IF EXISTS outreach_costs_one_time_month_check;
ALTER TABLE outreach_costs
    ADD CONSTRAINT outreach_costs_one_time_month_check CHECK (cadence <> 'one_time' OR cost_month IS NOT NULL);

COMMIT;
