/**
 * Remaining credit balances for the agency's email providers, cached in
 * `agency_provider_credits` (migration 0064) and pushed to the Pipeline tab over
 * Supabase Realtime. Both endpoints authenticate with the vault key in `x-api-key`:
 *   TryKitt  GET https://api.trykitt.ai/credit      → { credits: 14.4012 }
 *   Enrow    GET https://api.enrow.io/account/info  → { credits: 1968.25, credits_breakdown: {...} }
 * OpenAI has no balance endpoint for standard API keys, so it is not covered.
 *
 * Writers: pipeline batches after spending credits (throttled), and the Pipeline
 * tab when the cached row is stale or the user clicks refresh.
 */

import { pool } from '../config/db.js';
import { getAgencySettings } from './db/agencySettings.js';

const REQUEST_TIMEOUT_MS = 8000;
/** Pipeline batches refresh at most this often per agency. */
export const PIPELINE_REFRESH_INTERVAL_MS = 15_000;
/** A page view refreshes the row when it is older than this. */
const STALE_AFTER_MS = 2 * 60 * 1000;
/** Floor between manual refreshes, so repeated clicks don't hit the providers. */
const MANUAL_REFRESH_INTERVAL_MS = 5_000;

/**
 * @typedef {{ status: 'ok', credits: number }
 *   | { status: 'not_configured' }
 *   | { status: 'error', error: string }} ProviderBalance
 */

/**
 * @param {unknown} body
 * @returns {number | null}
 */
export function parseCreditsBody(body) {
    const raw = body && typeof body === 'object' ? /** @type {any} */ (body).credits : null;
    const n = typeof raw === 'string' ? Number(raw) : raw;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * @param {string} url
 * @param {string} apiKey
 * @returns {Promise<ProviderBalance>}
 */
async function fetchBalance(url, apiKey) {
    if (!apiKey) return { status: 'not_configured' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { 'x-api-key': apiKey },
            signal: controller.signal
        });
        if (res.status === 401 || res.status === 403) return { status: 'error', error: 'Invalid API key' };
        if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };
        const credits = parseCreditsBody(await res.json().catch(() => null));
        if (credits === null) return { status: 'error', error: 'Unexpected response' };
        return { status: 'ok', credits };
    } catch (err) {
        return { status: 'error', error: err?.name === 'AbortError' ? 'Timed out' : 'Request failed' };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @param {string} agencyId
 */
export async function getProviderCreditsRow(agencyId) {
    const result = await pool.query(
        `SELECT * FROM agency_provider_credits WHERE agency_id = $1`,
        [agencyId]
    );
    return result.rows[0] || null;
}

/**
 * Atomically claim the right to refresh: only one caller per interval wins, so
 * parallel batches of the same agency don't all call the providers.
 *
 * @param {string} agencyId
 * @param {number} minIntervalMs
 * @returns {Promise<boolean>}
 */
async function claimRefresh(agencyId, minIntervalMs) {
    const result = await pool.query(
        `INSERT INTO agency_provider_credits (agency_id, refresh_claimed_at)
         VALUES ($1, NOW())
         ON CONFLICT (agency_id) DO UPDATE SET refresh_claimed_at = NOW()
         WHERE agency_provider_credits.refresh_claimed_at IS NULL
            OR agency_provider_credits.refresh_claimed_at < NOW() - make_interval(secs => $2)
         RETURNING agency_id`,
        [agencyId, minIntervalMs / 1000]
    );
    return result.rowCount > 0;
}

/**
 * Fetch both balances and write them. A failed lookup keeps the last known
 * credit count (status 'error' flags it) rather than blanking it.
 *
 * @param {string} agencyId
 * @param {{ minIntervalMs?: number }} [opts]
 * @returns {Promise<object | null>} the updated row, or null when another caller holds the claim.
 */
export async function refreshProviderCredits(agencyId, { minIntervalMs = PIPELINE_REFRESH_INTERVAL_MS } = {}) {
    if (!(await claimRefresh(agencyId, minIntervalMs))) return null;

    const settings = await getAgencySettings(agencyId);
    const [trykitt, enrow] = await Promise.all([
        fetchBalance('https://api.trykitt.ai/credit', String(settings?.trykitt_key || '').trim()),
        fetchBalance('https://api.enrow.io/account/info', String(settings?.enrow_key || '').trim())
    ]);

    const result = await pool.query(
        `UPDATE agency_provider_credits SET
            trykitt_status = $2,
            trykitt_credits = CASE $2 WHEN 'ok' THEN $3::double precision
                WHEN 'error' THEN trykitt_credits ELSE NULL END,
            trykitt_error = $4,
            enrow_status = $5,
            enrow_credits = CASE $5 WHEN 'ok' THEN $6::double precision
                WHEN 'error' THEN enrow_credits ELSE NULL END,
            enrow_error = $7,
            fetched_at = NOW(),
            updated_at = NOW()
         WHERE agency_id = $1
         RETURNING *`,
        [
            agencyId,
            trykitt.status, trykitt.status === 'ok' ? trykitt.credits : null, trykitt.status === 'error' ? trykitt.error : null,
            enrow.status, enrow.status === 'ok' ? enrow.credits : null, enrow.status === 'error' ? enrow.error : null
        ]
    );
    return result.rows[0] || null;
}

/**
 * Pipeline hook: refresh after a batch spent credits. Never throws — a balance
 * lookup must not fail or slow an enrichment batch beyond the request timeout.
 *
 * @param {string} agencyId
 * @param {{ force?: boolean }} [opts] force skips the throttle (e.g. a batch that
 *        just failed, possibly on exhausted credits).
 */
export async function refreshProviderCreditsAfterBatch(agencyId, { force = false } = {}) {
    if (!agencyId) return;
    try {
        await refreshProviderCredits(agencyId, { minIntervalMs: force ? 0 : PIPELINE_REFRESH_INTERVAL_MS });
    } catch (err) {
        console.warn(`[providerCredits] refresh failed for ${agencyId}: ${err?.message || err}`);
    }
}

/**
 * Pipeline tab read: the cached row, refreshed first when missing, stale or
 * explicitly requested. Writes reach every open tab through Realtime.
 *
 * @param {string} agencyId
 * @param {{ force?: boolean }} [opts]
 */
export async function getAgencyProviderCredits(agencyId, { force = false } = {}) {
    const row = await getProviderCreditsRow(agencyId);
    const fetchedAt = row?.fetched_at ? new Date(row.fetched_at).getTime() : 0;
    if (force || Date.now() - fetchedAt > STALE_AFTER_MS) {
        const refreshed = await refreshProviderCredits(agencyId, {
            minIntervalMs: force ? MANUAL_REFRESH_INTERVAL_MS : PIPELINE_REFRESH_INTERVAL_MS
        });
        if (refreshed) return refreshed;
    }
    return row;
}
