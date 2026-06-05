/**
 * Supabase authentication middleware for Express routes.
 * req.agencyId = legacy agency_id from agency_auth_map when mapped, else Supabase user id.
 */

import { resolveAuthFromBearerToken } from '../utils/authCache.js';

export async function verifySupabaseToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing or invalid Authorization header' });
        }

        const token = authHeader.slice(7);
        const auth = await resolveAuthFromBearerToken(token);
        req.auth = {
            agencyId: auth.agencyId,
            supabaseUserId: auth.supabaseUserId,
            uid: auth.agencyId,
            email: auth.email,
            emailVerified: auth.emailVerified
        };
        req.agencyId = auth.agencyId;
        next();
    } catch (error) {
        console.error('Supabase token verification failed:', error.message);
        const statusCode = Number(error?.statusCode || 401);
        res.status(statusCode).json({ error: error?.message || 'Unauthorized' });
    }
}

/** @deprecated alias */
export const verifyFirebaseToken = verifySupabaseToken;

export default verifySupabaseToken;
