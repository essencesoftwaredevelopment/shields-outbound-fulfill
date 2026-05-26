import { resolveAgencyId } from './bearerAuth.js';
import { getOrCreateClient, resolveClientRow } from '../services/db/queries.js';

export async function agencyFromRequest(req) {
    return resolveAgencyId(req);
}

/**
 * Resolve the SQL client row for an incoming request.
 *
 * By default this DOES NOT create a client when the slug/id is unknown — a stale
 * or mistyped URL must not silently materialise a phantom client (which used to
 * leave behind rows with name = <slug>, slug = NULL and trigger background syncs).
 * Pass `{ createIfMissing: true }` from explicit write endpoints (uploads,
 * migrations, etc.) that legitimately want to bootstrap a new client.
 */
export async function clientContextFromRequest(req, clientIdOrSlug, { createIfMissing = false } = {}) {
    const agencyId = await resolveAgencyId(req);
    const slug = String(clientIdOrSlug || '').trim();
    const row = slug ? await resolveClientRow(agencyId, slug) : null;
    let sqlClientId = row?.id ?? null;
    if (sqlClientId === null && createIfMissing && slug) {
        sqlClientId = await getOrCreateClient(agencyId, slug);
    }
    return {
        agencyId,
        clientSlug: row?.slug || slug,
        sqlClientId,
        row
    };
}
