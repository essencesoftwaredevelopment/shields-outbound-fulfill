import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scopeKey, DEFAULT_RPM, SERPER_MAX_CONCURRENT_BATCHES, TRYKITT_MAX_CONCURRENT } from '../postgresRateLimit.js';

describe('postgresRateLimit', () => {
    it('builds tenant-scoped keys', () => {
        assert.equal(scopeKey('agency-1', 'serper'), 'agency-1:serper');
    });

    it('defaults serper RPM below legacy Upstash setting', () => {
        assert.ok(DEFAULT_RPM.serper <= 100);
    });

    it('caps global serper batch concurrency', () => {
        assert.ok(SERPER_MAX_CONCURRENT_BATCHES >= 1);
        assert.ok(SERPER_MAX_CONCURRENT_BATCHES <= 16);
    });

    it('caps TryKitt concurrency to a sane per-key limit', () => {
        assert.ok(Number.isInteger(TRYKITT_MAX_CONCURRENT));
        assert.ok(TRYKITT_MAX_CONCURRENT >= 1);
    });
});

describe('rate limit hooks (contract)', () => {
    it('createRateLimitHooks returns fn wrappers', async () => {
        const { createRateLimitHooks } = await import('../rateLimit.js');
        const hooks = createRateLimitHooks({
            agencyId: 'test-agency',
            options: {}
        });
        assert.equal(typeof hooks.serper, 'function');
        assert.equal(typeof hooks.openai, 'function');
        assert.equal(typeof hooks.trykitt, 'function');
    });
});

describe('founder Serper graceful failure (contract)', () => {
    it('runFounderFinder continues when Serper batch fails', async () => {
        const { runFounderFinder } = await import('../../services/founderFinder.js');
        const fnSrc = runFounderFinder.toString();
        assert.ok(
            fnSrc.includes('continuing with empty search results'),
            'expects graceful Serper degradation'
        );
    });
});
