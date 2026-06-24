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

export async function upsertAgencyAuthMap(supabaseUserId, agencyId, note = null) {
    await pool.query(
        `INSERT INTO agency_auth_map (supabase_user_id, agency_id, note)
         VALUES ($1::uuid, $2, $3)
         ON CONFLICT (supabase_user_id) DO UPDATE SET
             agency_id = EXCLUDED.agency_id,
             note = EXCLUDED.note`,
        [supabaseUserId, agencyId, note]
    );
    agencyIdCache.delete(supabaseUserId);
}

export async function listAgencyAuthMaps() {
    const result = await pool.query(
        `SELECT supabase_user_id, agency_id, note, created_at
         FROM agency_auth_map
         ORDER BY created_at DESC`
    );
    return result.rows;
}
