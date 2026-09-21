import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildForcedOfferCtaInstructions,
    ESSENCE_BUILD_OFFER_URL,
    mergeSizeEstimateIntoBrief,
    normalizeSizeEstimate,
    SEVEN_FIGURE_REVENUE_FLOOR,
    shouldOfferBuildCta,
    sizeEstimateFromContactInsights
} from '../sizeEstimate.js';

test('shouldOfferBuildCta requires high confidence and seven-figure likely', () => {
    assert.equal(shouldOfferBuildCta(null), false);
    assert.equal(
        shouldOfferBuildCta({
            isSevenFigureLikely: true,
            confidence: 'medium',
            rationale: 'maybe'
        }),
        false
    );
    assert.equal(
        shouldOfferBuildCta({
            isSevenFigureLikely: false,
            confidence: 'high',
            rationale: 'small'
        }),
        false
    );
    assert.equal(
        shouldOfferBuildCta({
            isSevenFigureLikely: true,
            confidence: 'high',
            rationale: 'strong signals'
        }),
        true
    );
});

test('normalizeSizeEstimate fills defaults and clamps lists', () => {
    const normalized = normalizeSizeEstimate({
        isSevenFigureLikely: true,
        estimatedAnnualRevenueMin: 2_500_000.7,
        confidence: 'HIGH',
        rationale: '  funded + reviews  ',
        signals: ['a', '', 'b'],
        sources: [{ title: 'Press', url: 'https://example.com/a' }, { url: '' }]
    });
    assert.equal(normalized.isSevenFigureLikely, true);
    assert.equal(normalized.estimatedAnnualRevenueMin, 2_500_001);
    assert.equal(normalized.confidence, 'high');
    assert.equal(normalized.rationale, 'funded + reviews');
    assert.deepEqual(normalized.signals, ['a', 'b']);
    assert.equal(normalized.sources.length, 1);
    assert.equal(normalized.source, 'openai_web_search');
});

test('sizeEstimateFromContactInsights short-circuits clear $1M+ and sub-$1M bands', () => {
    const over = sizeEstimateFromContactInsights({
        annual_revenue_min: SEVEN_FIGURE_REVENUE_FLOOR,
        annual_revenue_text: '1-10M'
    });
    assert.equal(shouldOfferBuildCta(over), true);
    assert.equal(over.source, 'contact_insights');

    const under = sizeEstimateFromContactInsights({
        annual_revenue_max: 500_000,
        annual_revenue_text: '<500k'
    });
    assert.equal(shouldOfferBuildCta(under), false);
    assert.equal(under.isSevenFigureLikely, false);
    assert.equal(under.confidence, 'high');

    assert.equal(
        sizeEstimateFromContactInsights({ annual_revenue_min: 250_000 }),
        null,
        'ambiguous mid-band should run the agent'
    );
});

test('mergeSizeEstimateIntoBrief attaches to existing brief or builds a shell', () => {
    const size = normalizeSizeEstimate({
        isSevenFigureLikely: true,
        confidence: 'high',
        rationale: 'scale signals',
        sources: [{ title: 'Site', url: 'https://brand.com' }]
    });
    const merged = mergeSizeEstimateIntoBrief(
        { company: 'Brand', domain: 'brand.com', summary: 'Sells widgets.', talkingPoints: [], risks: [], sources: [] },
        size
    );
    assert.equal(merged.summary, 'Sells widgets.');
    assert.equal(merged.sizeEstimate.confidence, 'high');

    const shell = mergeSizeEstimateIntoBrief(null, size, { company: 'Brand', domain: 'brand.com' });
    assert.ok(shell.summary);
    assert.equal(shell.company, 'Brand');
    assert.equal(shell.sizeEstimate.isSevenFigureLikely, true);
});

test('buildForcedOfferCtaInstructions bans Calendly and pins the VSL URL', () => {
    const text = buildForcedOfferCtaInstructions(`${ESSENCE_BUILD_OFFER_URL}?utm_source=test`);
    assert.ok(text.includes('Do NOT include a Calendly'));
    assert.ok(text.includes(`${ESSENCE_BUILD_OFFER_URL}?utm_source=test`));
    assert.ok(text.includes('Soft eligibility'));
});
