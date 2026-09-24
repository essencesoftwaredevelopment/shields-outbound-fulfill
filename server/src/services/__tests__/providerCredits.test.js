import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCreditsBody } from '../providerCredits.js';

describe('parseCreditsBody', () => {
    it('reads the TryKitt and Enrow balance shapes', () => {
        assert.equal(parseCreditsBody({ credits: 14.4012 }), 14.4012);
        assert.equal(
            parseCreditsBody({ credits: 1968.25, credits_breakdown: { paygo: 0, subscription: 1968.25 } }),
            1968.25
        );
        assert.equal(parseCreditsBody({ credits: 0 }), 0);
        assert.equal(parseCreditsBody({ credits: '12.5' }), 12.5);
    });

    it('returns null for missing or non-numeric credits', () => {
        for (const body of [null, undefined, 'x', {}, { credits: null }, { credits: 'n/a' }, { message: '' }]) {
            assert.equal(parseCreditsBody(body), null, JSON.stringify(body));
        }
    });
});
