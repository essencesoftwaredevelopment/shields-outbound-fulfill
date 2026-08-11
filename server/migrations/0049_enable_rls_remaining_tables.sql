-- 0049_enable_rls_remaining_tables.sql
-- Fix Supabase advisor "rls_disabled_in_public": enable RLS on the remaining
-- public tables that were created without it. These are server-only tables
-- (webhook ingest, sync bookkeeping, rate limiting, staging) — no browser
-- client reads them, so deny-by-default with no policies is intentional,
-- matching calendly_bookings / calendly_events / shopping_audits.
-- Server access is unaffected: the app connects as "postgres" (BYPASSRLS).

BEGIN;

ALTER TABLE api_concurrency_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_rate_limit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_instantly_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_instantly_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_scripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE instantly_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE instantly_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE interested_autoresponder_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE interested_autoresponder_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_defaults ENABLE ROW LEVEL SECURITY;

-- Ad-hoc prod table not created by a checked-in migration; guard with IF EXISTS.
ALTER TABLE IF EXISTS staging_instantly_leads ENABLE ROW LEVEL SECURITY;

COMMIT;
