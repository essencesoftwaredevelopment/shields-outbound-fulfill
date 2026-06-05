import { pool } from '../../config/db.js';

const AGENCY_ID_CACHE_TTL_MS = 5 * 60_000;
const agencyIdCache = new Map();

/**
 * Legacy agency_id used in SQL rows (Firebase uid). Falls back to Supabase user id when unmapped.
 */
export async function resolveLegacyAgencyId(supabaseUserId) {
    if (!supabaseUserId) {
        throw new Error('supabaseUserId is required');
    }

    const cached = agencyIdCache.get(supabaseUserId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
    }

    const result = await pool.query(
        `SELECT agency_id FROM agency_auth_map WHERE supabase_user_id = $1::uuid`,
        [supabaseUserId]
    );
    const agencyId = result.rows[0]?.agency_id ?? String(supabaseUserId);
    agencyIdCache.set(supabaseUserId, {
        value: agencyId,
        expiresAt: Date.now() + AGENCY_ID_CACHE_TTL_MS
    });
    return agencyId;
}
