import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildStoreLeadsDomainParams,
    mapStoreLeadsDomain,
    normalizeStoreLeadsSegment,
    segmentExcludesDomain
} from '../storeLeads.js';
import { describeSegment } from '../../routes/storeLeads.js';

const icp = {
    minMonthlySales: 50000,
    countries: ['us', 'CA'],
    technologies: ['Klaviyo'],
    states: ['Active']
};

describe('normalizeStoreLeadsSegment', () => {
    it('canonicalizes a typical ICP segment', () => {
        const { segment, error } = normalizeStoreLeadsSegment(icp);
        assert.equal(error, undefined);
        assert.deepEqual(segment.countries, ['US', 'CA']);
        assert.equal(segment.minMonthlySales, 50000);
        assert.equal(segment.maxMonthlySales, null);
        assert.equal(segment.technologiesMatch, 'any');
        assert.equal(segment.customDomainsOnly, true);
    });

    it('rejects a segment with no narrowing filter', () => {
        assert.match(normalizeStoreLeadsSegment({ states: ['Active'] }).error, /at least one filter/);
    });

    it('rejects min above max and required+excluded overlap', () => {
        assert.match(normalizeStoreLeadsSegment({ minMonthlySales: 10, maxMonthlySales: 5 }).error, /above the maximum/);
        assert.match(
            normalizeStoreLeadsSegment({ countries: ['US'], technologies: ['Klaviyo'], excludeTechnologies: ['klaviyo'] }).error,
            /both required and excluded/
        );
    });

    it('drops invalid countries, states and dates', () => {
        const { segment } = normalizeStoreLeadsSegment({
            countries: ['USA', 'us'],
            states: ['Active', 'Bogus'],
            createdAfter: 'yesterday'
        });
        assert.deepEqual(segment.countries, ['US']);
        assert.deepEqual(segment.states, ['Active']);
        assert.equal(segment.createdAfter, null);
    });
});

describe('buildStoreLeadsDomainParams', () => {
    it('converts dollars to cents and ORs multi-value exclusive filters', () => {
        const { segment } = normalizeStoreLeadsSegment({ ...icp, platforms: ['Shopify', 'woocommerce'] });
        assert.deepEqual(buildStoreLeadsDomainParams(segment), [
            ['f:ermin', '5000000'],
            ['f:cc', 'US,CA'],
            ['f:cc:op', 'or'],
            ['f:p', 'shopify,woocommerce'],
            ['f:p:op', 'or'],
            ['f:ds', 'Active'],
            ['f:tech', 'Klaviyo'],
            ['f:ismy', 'false']
        ]);
    });

    it('uses and for "all" technologies and escapes commas', () => {
        const { segment } = normalizeStoreLeadsSegment({
            countries: ['US'],
            technologies: ['Klaviyo', 'Foo, Inc'],
            technologiesMatch: 'all',
            customDomainsOnly: false,
            createdAfter: '2026-07-01'
        });
        const params = Object.fromEntries(buildStoreLeadsDomainParams(segment));
        assert.equal(params['f:tech'], 'Klaviyo,Foo\\, Inc');
        assert.equal(params['f:tech:op'], 'and');
        assert.equal(params['f:cratmin'], '2026-07-01');
        assert.equal(params['f:ismy'], undefined);
    });
});

describe('mapStoreLeadsDomain', () => {
    it('maps a Store Leads domain onto company fields', () => {
        const mapped = mapStoreLeadsDomain({
            name: 'www.Example.com',
            aliases: ['example.co', 'www.example.com'],
            estimated_sales: 7512345,
            country_code: 'us',
            platform: 'Shopify',
            plan: 'Shopify Plus',
            state: 'Active',
            apps: [{ name: 'Klaviyo: Email Marketing & SMS' }, { name: 'Recharge' }],
            technologies: [{ name: 'Google Analytics' }, { name: 'Google Analytics' }]
        });
        assert.deepEqual(mapped, {
            domain: 'example.com',
            aliases: ['example.co'],
            estMonthlySalesUsd: 75123.45,
            countryCode: 'US',
            platform: 'shopify',
            plan: 'Shopify Plus',
            state: 'Active',
            apps: ['Klaviyo: Email Marketing & SMS', 'Recharge'],
            technologies: ['Google Analytics'],
            usesKlaviyo: true,
            usesShopify: true
        });
    });

    it('handles sparse records and missing names', () => {
        assert.equal(mapStoreLeadsDomain({}), null);
        const mapped = mapStoreLeadsDomain({ name: 'shop.test' });
        assert.equal(mapped.estMonthlySalesUsd, null);
        assert.equal(mapped.usesKlaviyo, false);
        assert.equal(mapped.usesShopify, null);
    });
});

describe('segmentExcludesDomain', () => {
    it('matches exclusions case-insensitively against apps and technologies', () => {
        const { segment } = normalizeStoreLeadsSegment({ countries: ['US'], excludeTechnologies: ['attentive'] });
        const base = { apps: [], technologies: [] };
        assert.equal(segmentExcludesDomain(segment, { ...base, technologies: ['Attentive'] }), true);
        assert.equal(segmentExcludesDomain(segment, { ...base, apps: ['Postscript'] }), false);
    });
});

describe('describeSegment', () => {
    it('builds a short batch label', () => {
        const { segment } = normalizeStoreLeadsSegment(icp);
        assert.equal(describeSegment(segment), 'US/CA · ≥$50k/mo · Klaviyo');
    });
});
