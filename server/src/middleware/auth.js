/**
 * Supabase authentication middleware for Express routes.
 * req.agencyId = legacy agency_id from agency_auth_map when mapped, else Supabase user id.
 */

import { getSupabaseAdmin } from '../config/supabase.js';
import { env } from '../config/env.js';
import { resolveLegacyAgencyId } from '../services/db/agencyAuthMap.js';

let supabaseAdmin = null;

function getAdmin() {
    if (!supabaseAdmin) {
        if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
            throw new Error('Supabase auth is not configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)');
        }
        supabaseAdmin = getSupabaseAdmin();
    }
    return supabaseAdmin;
}

export async function verifySupabaseToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing or invalid Authorization header' });
        }

        const token = authHeader.slice(7);
        const { data, error } = await getAdmin().auth.getUser(token);

        if (error || !data?.user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const user = data.user;
        const agencyId = await resolveLegacyAgencyId(user.id);
        req.auth = {
            agencyId,
            supabaseUserId: user.id,
            uid: agencyId,
            email: user.email,
            emailVerified: !!user.email_confirmed_at
        };
        req.agencyId = agencyId;
        next();
    } catch (error) {
        console.error('Supabase token verification failed:', error.message);
        res.status(401).json({ error: 'Unauthorized' });
    }
}

/** @deprecated alias */
export const verifyFirebaseToken = verifySupabaseToken;

export default verifySupabaseToken;
