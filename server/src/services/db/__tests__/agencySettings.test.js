import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    isTryKittPaidAccount,
    rateLimitsFromSettings,
    TRYKITT_FREE_TIER_LIMITS
} from '../agencySettings.js';

const settings = (features) => ({ features });

describe('isTryKittPaidAccount', () => {
    it('defaults to paid when the flag is absent (preserves legacy behavior)', () => {
        assert.equal(isTryKittPaidAccount(null), true);
        assert.equal(isTryKittPaidAccount(settings(null)), true);
        assert.equal(isTryKittPaidAccount(settings({})), true);
        assert.equal(isTryKittPaidAccount(settings({ shoppingAudit: true })), true);
    });

    it('is free only when explicitly false', () => {
        assert.equal(isTryKittPaidAccount(settings({ trykittPaidAccount: false })), false);
        assert.equal(isTryKittPaidAccount(settings({ trykittPaidAccount: true })), true);
    });
});

describe('rateLimitsFromSettings', () => {
    it('returns no limits for a paid account — concurrency-only gating, no RPM window', () => {
        assert.deepEqual(rateLimitsFromSettings(settings({ trykittPaidAccount: true })), {});
        assert.deepEqual(rateLimitsFromSettings(settings({})), {});
        assert.deepEqual(rateLimitsFromSettings(null), {});
    });

    it('applies free-tier caps when the account is marked free', () => {
        assert.deepEqual(
            rateLimitsFromSettings(settings({ trykittPaidAccount: false })),
            { ...TRYKITT_FREE_TIER_LIMITS }
        );
    });

    it('lets an explicit rateLimits entry override the free-tier caps', () => {
        const result = rateLimitsFromSettings(
            settings({ trykittPaidAccount: false, rateLimits: { trykittConcurrency: 5 } })
        );
        assert.equal(result.trykittConcurrency, 5);
        assert.equal(result.trykitt, TRYKITT_FREE_TIER_LIMITS.trykitt, 'unset keys keep free-tier value');
    });

    it('lets an explicit rateLimits entry throttle a paid account', () => {
        assert.deepEqual(
            rateLimitsFromSettings(settings({ trykittPaidAccount: true, rateLimits: { trykitt: 120 } })),
            { trykitt: 120 }
        );
    });

    it('ignores malformed limit values rather than passing them to the gate', () => {
        const result = rateLimitsFromSettings(
            settings({ rateLimits: { trykitt: 0, trykittConcurrency: -3, serper: 'abc', openai: null } })
        );
        assert.deepEqual(result, {});
    });

    it('reads serper and openai overrides too', () => {
        assert.deepEqual(
            rateLimitsFromSettings(settings({ rateLimits: { serper: 30, openai: 200 } })),
            { serper: 30, openai: 200 }
        );
    });

    it('does not mutate the shared free-tier constant', () => {
        const result = rateLimitsFromSettings(
            settings({ trykittPaidAccount: false, rateLimits: { trykittConcurrency: 9 } })
        );
        assert.equal(result.trykittConcurrency, 9);
        assert.equal(TRYKITT_FREE_TIER_LIMITS.trykittConcurrency, 2);
    });
});
