/**
 * Resend (Discovery Pre Call + activity webhooks) is only for the
 * essence-retention client on the Essence Retention agency.
 *
 * Another tenant also has a client slug `essence-retention`, so slug
 * alone is not enough — agency_id must match too.
 */

export const ESSENCE_RETENTION_AGENCY_ID = 'HoPJjMpaKjMqw6TCjlzz9jYEoFM2';
export const ESSENCE_RETENTION_CLIENT_SLUG = 'essence-retention';

export function isEssenceRetentionClient({ agencyId, clientSlug } = {}) {
    const slug = String(clientSlug || '').trim().toLowerCase();
    return agencyId === ESSENCE_RETENTION_AGENCY_ID
        && slug === ESSENCE_RETENTION_CLIENT_SLUG;
}
