import { pool } from '../../config/db.js';

/**
 * Legacy agency_id used in SQL rows (Firebase uid). Falls back to Supabase user id when unmapped.
 */
export async function resolveLegacyAgencyId(supabaseUserId) {
    if (!supabaseUserId) {
        throw new Error('supabaseUserId is required');
    }
    const result = await pool.query(
        `SELECT agency_id FROM agency_auth_map WHERE supabase_user_id = $1::uuid`,
        [supabaseUserId]
    );
    return result.rows[0]?.agency_id ?? String(supabaseUserId);
}
