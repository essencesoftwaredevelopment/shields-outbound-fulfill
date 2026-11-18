import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAdLibraryUrl, parseActiveAdCount } from '../metaAds.js';
import {
    sanitizeMetaAdsInput,
    metaAdsModeFromOptions,
    metaAdsJobState
} from '../../enrichment/metaAdsOptions.js';

describe('parseActiveAdCount', () => {
    it('reads the approximate result count (as scraped)', () => {
        assert.equal(parseActiveAdCount('Cookies\n\n~36 results\n\nThese results include ads'), 36);
        assert.equal(parseActiveAdCount('[Ad Library]\n\n\\~1,600 results\n\nThese results'), 1600);
        assert.equal(parseActiveAdCount('Terms\n\n1 result\n\nThese results'), 1);
        assert.equal(parseActiveAdCount('x\n~1.2K results\n'), 1200);
        assert.equal(parseActiveAdCount('x\n~50,000+ results\n'), 50000);
    });

    it("reads Meta's no-ads message as zero", () => {
        assert.equal(parseActiveAdCount('Sort by\n\n…\n\nNo ads match your search criteria'), 0);
        assert.equal(parseActiveAdCount('x\n0 results\n'), 0);
    });

    it('returns null (never 0) when the page has no count', () => {
        assert.equal(parseActiveAdCount(''), null);
        assert.equal(parseActiveAdCount('Log in to Facebook\n\nYou must log in to continue.'), null);
        assert.equal(parseActiveAdCount('**24 ads** use this creative and text'), null);
    });
});

describe('buildAdLibraryUrl', () => {
    it('searches the domain as an exact phrase, active ads, all countries', () => {
        const url = new URL(buildAdLibraryUrl('soarbars.com'));
        assert.equal(url.searchParams.get('q'), '"soarbars.com"');
        assert.equal(url.searchParams.get('search_type'), 'keyword_exact_phrase');
        assert.equal(url.searchParams.get('active_status'), 'active');
        assert.equal(url.searchParams.get('country'), 'ALL');
    });
});

describe('meta ads options', () => {
    it('is off unless enabled', () => {
        assert.equal(sanitizeMetaAdsInput(null), null);
        assert.equal(sanitizeMetaAdsInput({ enabled: false, minActiveAds: 3 }), null);
        assert.equal(sanitizeMetaAdsInput('not json'), null);
    });

    it('accepts JSON strings (multipart uploads) and drops a bad minimum', () => {
        assert.deepEqual(sanitizeMetaAdsInput('{"enabled":true,"minActiveAds":"5"}'), {
            enabled: true, minActiveAds: 5, only: false
        });
        assert.deepEqual(sanitizeMetaAdsInput({ enabled: true, minActiveAds: 0 }), {
            enabled: true, minActiveAds: null, only: false
        });
    });

    it('ads-only ignores the gate', () => {
        assert.deepEqual(sanitizeMetaAdsInput({ enabled: true, minActiveAds: 5, only: true }), {
            enabled: true, minActiveAds: null, only: true
        });
    });

    it('picks the child mode', () => {
        assert.equal(metaAdsModeFromOptions({}), 'off');
        assert.equal(metaAdsModeFromOptions({ metaAds: { enabled: true } }), 'parallel');
        assert.equal(metaAdsModeFromOptions({ metaAds: { enabled: true, minActiveAds: 3 } }), 'gate');
        // No founder lookup → nothing to gate.
        assert.equal(
            metaAdsModeFromOptions({ skipFounderFinder: true, metaAds: { enabled: true, minActiveAds: 3 } }),
            'parallel'
        );
        assert.equal(metaAdsModeFromOptions({ metaAds: { enabled: true, only: true } }), 'only');
    });

    it('builds card state from options + stats', () => {
        assert.equal(metaAdsJobState({}), null);
        const state = metaAdsJobState({
            metaAds: { enabled: true, minActiveAds: 2 },
            metaAdsStats: { counted: 10, reused: 3, withAds: 7, errors: 1, gated: 4, credits: 12 }
        });
        assert.equal(state.counted, 10);
        assert.equal(state.gated, 4);
        assert.equal(state.minActiveAds, 2);
        assert.equal(state.lastError, null);
    });
});
