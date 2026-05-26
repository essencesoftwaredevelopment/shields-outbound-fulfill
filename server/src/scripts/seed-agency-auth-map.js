/**
 * Insert or update agency_auth_map row(s).
 *
 * Usage:
 *   SUPABASE_USER_ID=98aaab5e-c3e3-403f-8bce-3d8fb0b975e3 \
 *   LEGACY_AGENCY_ID=HoPJjMpaKjMqw6TCjlzz9jYEoFM2 \
 *   node server/src/scripts/seed-agency-auth-map.js
 */

import { pool } from '../config/db.js';

async function main() {
    const supabaseUserId = process.env.SUPABASE_USER_ID?.trim();
    const legacyAgencyId = process.env.LEGACY_AGENCY_ID?.trim();
    const note = process.env.NOTE?.trim() || null;

    if (!supabaseUserId || !legacyAgencyId) {
        console.error('Set SUPABASE_USER_ID and LEGACY_AGENCY_ID');
        process.exit(1);
    }

    await pool.query(
        `INSERT INTO agency_auth_map (supabase_user_id, agency_id, note)
         VALUES ($1::uuid, $2, $3)
         ON CONFLICT (supabase_user_id) DO UPDATE SET
             agency_id = EXCLUDED.agency_id,
             note = EXCLUDED.note`,
        [supabaseUserId, legacyAgencyId, note]
    );

    console.log('Mapped', supabaseUserId, '->', legacyAgencyId);
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
