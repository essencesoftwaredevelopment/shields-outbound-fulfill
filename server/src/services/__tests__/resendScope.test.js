import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ESSENCE_RETENTION_AGENCY_ID,
    ESSENCE_RETENTION_CLIENT_SLUG,
    isEssenceRetentionClient
} from '../resendScope.js';

test('isEssenceRetentionClient: only the Essence Retention agency + client', () => {
    assert.equal(isEssenceRetentionClient({
        agencyId: ESSENCE_RETENTION_AGENCY_ID,
        clientSlug: ESSENCE_RETENTION_CLIENT_SLUG
    }), true);
    assert.equal(isEssenceRetentionClient({
        agencyId: ESSENCE_RETENTION_AGENCY_ID,
        clientSlug: 'ESSENCE-Retention'
    }), true);
    assert.equal(isEssenceRetentionClient({
        agencyId: ESSENCE_RETENTION_AGENCY_ID,
        clientSlug: 'vulcan-digital'
    }), false);
    assert.equal(isEssenceRetentionClient({
        agencyId: 'efddb63d-a4c9-44d9-a204-baa052fd0fd8',
        clientSlug: ESSENCE_RETENTION_CLIENT_SLUG
    }), false);
    assert.equal(isEssenceRetentionClient({}), false);
});
