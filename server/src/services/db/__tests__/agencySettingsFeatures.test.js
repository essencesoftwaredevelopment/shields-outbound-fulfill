import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    hasShoppingAuditFeature,
    hasInterestedReplyShoppingAuditFeature
} from '../agencySettings.js';

const ENV_KEY = 'SHOPPING_AUDIT_ENABLED';
const savedEnv = process.env[ENV_KEY];

afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
});

describe('hasInterestedReplyShoppingAuditFeature (autoresponder preview gate)', () => {
    it('is enabled only by the per-agency autoresponderShoppingAudit feature', () => {
        assert.equal(
            hasInterestedReplyShoppingAuditFeature({ features: { autoresponderShoppingAudit: true } }),
            true
        );
        assert.equal(
            hasInterestedReplyShoppingAuditFeature({ features: { autoresponderShoppingAudit: false } }),
            false
        );
        assert.equal(hasInterestedReplyShoppingAuditFeature({ features: {} }), false);
        assert.equal(hasInterestedReplyShoppingAuditFeature(null), false);
    });

    it('does NOT piggyback on the pipeline feature (features.shoppingAudit)', () => {
        // Several agencies have pipeline access; only Vulcan sends audit-preview replies.
        assert.equal(
            hasInterestedReplyShoppingAuditFeature({ features: { shoppingAudit: true } }),
            false
        );
    });

    it('is NOT flipped by the global SHOPPING_AUDIT_ENABLED env override', () => {
        process.env[ENV_KEY] = 'true';
        // The env override still applies to the pipeline gate…
        assert.equal(hasShoppingAuditFeature({ features: {} }), true);
        // …but must never turn every agency's replies into audit previews
        // (the regression that sent audit previews for list-growth agencies).
        assert.equal(hasInterestedReplyShoppingAuditFeature({ features: {} }), false);
    });
});
