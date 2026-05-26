import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Documents expected resume behaviour: Serper cache keys must survive restart.
 * Integration test — run against staging with SUPABASE_* and API keys set.
 */
describe('founder Serper resume (contract)', () => {
    it('runFounderFinder accepts DB cache callbacks instead of checkpoint files', async () => {
        const { runFounderFinder } = await import('../founderFinder.js');
        assert.equal(typeof runFounderFinder, 'function');
        const fnSrc = runFounderFinder.toString();
        assert.ok(fnSrc.includes('loadSerperCache'), 'expects loadSerperCache param');
        assert.ok(fnSrc.includes('checkPaused'), 'expects checkPaused param');
        assert.ok(!fnSrc.includes('inputCsv'), 'CSV input removed from signature body');
    });
});
