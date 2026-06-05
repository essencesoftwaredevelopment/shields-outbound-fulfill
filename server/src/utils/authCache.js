import { getSupabaseAdmin } from '../config/supabase.js';
import { resolveLegacyAgencyId } from '../services/db/agencyAuthMap.js';

const AUTH_CACHE_TTL_MS = 60_000;
const authCache = new Map();

function pruneAuthCache() {
    if (authCache.size <= 500) return;
    const now = Date.now();
    for (const [key, entry] of authCache) {
        if (entry.expiresAt <= now) {
            authCache.delete(key);
        }
    }
}

/**
 * Verify a Supabase bearer token and resolve legacy agency_id.
 * Results are cached briefly to avoid repeated getUser round-trips per session.
 */
export async function resolveAuthFromBearerToken(token) {
    const normalizedToken = String(token || '').trim();
    if (!normalizedToken) {
        const error = new Error('Missing authorization token.');
        error.statusCode = 401;
        throw error;
    }

    const cached = authCache.get(normalizedToken);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
    }

    const { data, error } = await getSupabaseAdmin().auth.getUser(normalizedToken);
    if (error || !data?.user?.id) {
        const err = new Error('Unauthorized');
        err.statusCode = 401;
        throw err;
    }

    const user = data.user;
    const agencyId = await resolveLegacyAgencyId(user.id);
    const value = {
        agencyId,
        supabaseUserId: user.id,
        email: user.email ?? null,
        emailVerified: !!user.email_confirmed_at
    };

    authCache.set(normalizedToken, {
        value,
        expiresAt: Date.now() + AUTH_CACHE_TTL_MS
    });
    pruneAuthCache();
    return value;
}
