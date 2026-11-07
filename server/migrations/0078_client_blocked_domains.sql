-- 0078_client_blocked_domains.sql
-- Purpose: per-client domain blocklist. Nobody whose email domain or company
-- domain is on it gets emailed by follow-ups, the follow-up agent, the
-- interested autoresponder, or added to an Instantly campaign
-- (server/src/services/doNotEmail.js). Lowercase bare domains, e.g. 'shop.com';
-- subdomains match too.

BEGIN;

ALTER TABLE clients
    ADD COLUMN IF NOT EXISTS blocked_domains TEXT[] NOT NULL DEFAULT '{}';

COMMIT;
