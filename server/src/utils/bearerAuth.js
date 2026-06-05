import { resolveAuthFromBearerToken } from './authCache.js';

/**
 * Resolve legacy agency_id from Bearer token or legacy idToken in body/query.
 */
export async function resolveAgencyId(req) {
    const authHeader = String(req.headers.authorization || '').trim();
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const token = bearerMatch?.[1] || String(req.query?.idToken || req.body?.idToken || '').trim();
    const auth = await resolveAuthFromBearerToken(token);
    return auth.agencyId;
}
