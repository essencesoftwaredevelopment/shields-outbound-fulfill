import { getSupabaseAdmin } from '../config/supabase.js';
import { resolveLegacyAgencyId } from '../services/db/agencyAuthMap.js';

/**
 * Resolve legacy agency_id from Bearer token or legacy idToken in body/query.
 */
export async function resolveAgencyId(req) {
    const authHeader = String(req.headers.authorization || '').trim();
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const token = bearerMatch?.[1] || String(req.query?.idToken || req.body?.idToken || '').trim();
    if (!token) {
        const error = new Error('Missing authorization token.');
        error.statusCode = 401;
        throw error;
    }

    const { data, error } = await getSupabaseAdmin().auth.getUser(token);
    if (error || !data?.user?.id) {
        const err = new Error('Unauthorized');
        err.statusCode = 401;
        throw err;
    }
    return resolveLegacyAgencyId(data.user.id);
}
