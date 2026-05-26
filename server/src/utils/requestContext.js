import { resolveAgencyId } from './bearerAuth.js';
import { getOrCreateClient, resolveClientRow } from '../services/db/queries.js';

export async function agencyFromRequest(req) {
    return resolveAgencyId(req);
}

export async function clientContextFromRequest(req, clientIdOrSlug) {
    const agencyId = await resolveAgencyId(req);
    const slug = String(clientIdOrSlug || '').trim();
    const row = slug ? await resolveClientRow(agencyId, slug) : null;
    const sqlClientId = row?.id ?? (slug ? await getOrCreateClient(agencyId, slug) : null);
    return {
        agencyId,
        clientSlug: row?.slug || slug,
        sqlClientId,
        row
    };
}
