-- 0036_api_rate_limit_functions.sql
-- Single-query acquire helpers to avoid holding pool connections across round-trips.

BEGIN;

CREATE OR REPLACE FUNCTION try_record_rate_limit_event(
    p_scope_key text,
    p_max_rpm int
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    current_count int;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('rpm:' || p_scope_key));

    DELETE FROM api_rate_limit_events
    WHERE scope_key = p_scope_key
      AND requested_at < NOW() - INTERVAL '1 minute';

    SELECT COUNT(*)::int INTO current_count
    FROM api_rate_limit_events
    WHERE scope_key = p_scope_key
      AND requested_at > NOW() - INTERVAL '1 minute';

    IF current_count >= p_max_rpm THEN
        RETURN false;
    END IF;

    INSERT INTO api_rate_limit_events (scope_key) VALUES (p_scope_key);
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION try_acquire_api_lease(
    p_scope_key text,
    p_lease_id text,
    p_max_leases int,
    p_ttl_ms int
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    active_count int;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(p_scope_key));

    DELETE FROM api_concurrency_leases
    WHERE scope_key = p_scope_key
      AND acquired_at < NOW() - (p_ttl_ms || ' milliseconds')::interval;

    SELECT COUNT(*)::int INTO active_count
    FROM api_concurrency_leases
    WHERE scope_key = p_scope_key;

    IF active_count >= p_max_leases THEN
        RETURN false;
    END IF;

    INSERT INTO api_concurrency_leases (scope_key, lease_id)
    VALUES (p_scope_key, p_lease_id);

    RETURN true;
END;
$$;

COMMIT;
