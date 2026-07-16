import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSignalExportVars,
    precomputeDestinationChecks,
    runSignalWaterfall,
    runSignalWaterfallStage
} from '../signalWaterfall.js';
import { formatPriceUsd } from '../utils.js';
import { SIGNAL_TYPES } from '../constants.js';

const AD_LINK = 'https://grip6.com/products/merino-socks';

function makeSnapshot(overrides = {}) {
    return {
        domain_normalized: 'grip6.com',
        title: 'Merino Wool Crew Sock 3-Pack',
        variants: [
            { price: '74.97', available: true },
            { price: '79.97', available: true }
        ],
        review_signals: { review_count: 12, rating_value: 4.7 },
        ...overrides
    };
}

function makeAdCard(overrides = {}) {
    return {
        title: 'Merino Wool Crew Sock',
        price: '66.95',
        priceValue: 66.95,
        seller: 'grip6.com',
        link: AD_LINK,
        rating: null,
        ratingCount: null,
        delivery: '',
        priceTag: '',
        ...overrides
    };
}

function makeObservation(overrides = {}) {
    return {
        branch: 'clean',
        matched_card: makeAdCard(),
        all_cards: [],
        observed_at: '2026-07-12T00:00:00.000Z',
        ...overrides
    };
}

const OK_CHECKS = new Map([[AD_LINK, { broken: false, reason: null, statusCode: 200 }]]);
const BROKEN_CHECKS = new Map([[AD_LINK, { broken: true, reason: 'http_error', statusCode: 404 }]]);

test('collects primary by waterfall priority and keeps other fired signals as secondary', async () => {
    const rivalCards = [
        { title: 'Wool Hiking Socks', source: 'rivalstore.com', rating: 4.8, price: '59.99' }
    ];
    const signal = await runSignalWaterfall({
        snapshot: makeSnapshot(),
        observation: makeObservation({ all_cards: rivalCards }),
        domain: 'grip6.com',
        features: {},
        destinationChecks: OK_CHECKS
    });

    assert.equal(signal.signal_type, SIGNAL_TYPES.PRICE_MISMATCH);
    assert.deepEqual(
        signal.secondary_signals.map((s) => s.signal_type),
        [SIGNAL_TYPES.REVIEW_GAP, SIGNAL_TYPES.NO_STARS_VS_COMPETITOR]
    );
    assert.equal(signal.export_vars.issue, 'price mismatch');
    assert.equal(signal.export_vars.ad_price, '$66.95');
    assert.equal(signal.export_vars.page_price, '$74.97');
    assert.equal(signal.export_vars.product, 'Merino Wool Crew Sock 3-Pack');
});

test('enableTier2=false drops tier-2 signals from secondary', async () => {
    const rivalCards = [
        { title: 'Wool Hiking Socks', source: 'rivalstore.com', rating: 4.8, price: '59.99' }
    ];
    const signal = await runSignalWaterfall({
        snapshot: makeSnapshot(),
        observation: makeObservation({ all_cards: rivalCards }),
        domain: 'grip6.com',
        features: {},
        enableTier2: false,
        destinationChecks: OK_CHECKS
    });

    assert.deepEqual(
        signal.secondary_signals.map((s) => s.signal_type),
        [SIGNAL_TYPES.REVIEW_GAP]
    );
});

test('stock mismatch fires when every variant is unavailable', async () => {
    const snapshot = makeSnapshot({
        variants: [{ price: '66.95', available: false }],
        review_signals: {}
    });
    const signal = await runSignalWaterfall({
        snapshot,
        observation: makeObservation(),
        domain: 'grip6.com',
        features: {},
        destinationChecks: OK_CHECKS
    });

    assert.equal(signal.signal_type, SIGNAL_TYPES.STOCK_MISMATCH);
    assert.equal(signal.export_vars.issue, 'stock issue');
    assert.equal(signal.export_vars.page_price, '$66.95');
});

test('broken page fires from precomputed destination checks without network', async () => {
    const snapshot = makeSnapshot({
        variants: [{ price: '66.95', available: true }],
        review_signals: {}
    });
    const signal = await runSignalWaterfall({
        snapshot,
        observation: makeObservation(),
        domain: 'grip6.com',
        features: {},
        destinationChecks: BROKEN_CHECKS
    });

    assert.equal(signal.signal_type, SIGNAL_TYPES.BROKEN_PAGE);
    assert.equal(signal.export_vars.issue, 'broken link');
    assert.equal(signal.observed.page_status, 404);
});

test('enableBrokenPage=false skips the destination detector entirely', async () => {
    const snapshot = makeSnapshot({
        variants: [{ price: '66.95', available: true }],
        review_signals: {}
    });
    const signal = await runSignalWaterfall({
        snapshot,
        observation: makeObservation(),
        domain: 'grip6.com',
        features: {},
        enableBrokenPage: false,
        destinationChecks: BROKEN_CHECKS
    });

    assert.equal(signal.signal_type, SIGNAL_TYPES.AD_MATCH);
});

test('clean listing falls back to ad_match with empty issue but keeps prices', async () => {
    const snapshot = makeSnapshot({
        variants: [{ price: '66.95', available: true }],
        review_signals: {}
    });
    const signal = await runSignalWaterfall({
        snapshot,
        observation: makeObservation(),
        domain: 'grip6.com',
        features: {},
        destinationChecks: OK_CHECKS
    });

    assert.equal(signal.signal_type, SIGNAL_TYPES.AD_MATCH);
    assert.equal(signal.export_vars.issue, '');
    assert.equal(signal.export_vars.ad_price, '$66.95');
    assert.equal(signal.export_vars.page_price, '$66.95');
    assert.deepEqual(signal.secondary_signals, []);
});

test('no ad + weak feed title falls back to title_quality', async () => {
    const snapshot = makeSnapshot({ title: 'Socks', review_signals: {} });
    const signal = await runSignalWaterfall({
        snapshot,
        observation: { branch: 'none', matched_card: null, all_cards: [] },
        domain: 'grip6.com',
        features: {}
    });

    assert.equal(signal.signal_type, SIGNAL_TYPES.TITLE_QUALITY);
    assert.equal(signal.export_vars.issue, 'weak product title');
});

test('titleQualityFallback=false emits nothing for no-ad domains', async () => {
    const snapshot = makeSnapshot({ title: 'Socks', review_signals: {} });
    const signal = await runSignalWaterfall({
        snapshot,
        observation: { branch: 'none', matched_card: null, all_cards: [] },
        domain: 'grip6.com',
        features: { titleQualityFallback: false }
    });

    assert.equal(signal, null);
});

test('price delta below 2.5% of page price does not fire price_mismatch', async () => {
    const snapshot = makeSnapshot({ variants: [{ price: '74.97', available: true }], review_signals: {} });
    const signal = await runSignalWaterfall({
        snapshot,
        // delta $1.37 < 2.5% of $74.97 ($1.87)
        observation: makeObservation({ matched_card: makeAdCard({ price: '73.60', priceValue: 73.60 }) }),
        domain: 'grip6.com',
        features: {},
        destinationChecks: OK_CHECKS
    });
    assert.equal(signal.signal_type, SIGNAL_TYPES.AD_MATCH);
});

test('cheap products use the $0.75 absolute floor', async () => {
    const snapshot = makeSnapshot({ variants: [{ price: '10.00', available: true }], review_signals: {} });
    const below = await runSignalWaterfall({
        snapshot,
        // delta $0.60 < $0.75 floor (2.5% would only be $0.25)
        observation: makeObservation({ matched_card: makeAdCard({ price: '9.40', priceValue: 9.40 }) }),
        domain: 'grip6.com',
        features: {},
        destinationChecks: OK_CHECKS
    });
    assert.equal(below.signal_type, SIGNAL_TYPES.AD_MATCH);

    const above = await runSignalWaterfall({
        snapshot,
        // delta $1.10 >= $0.75 floor
        observation: makeObservation({ matched_card: makeAdCard({ price: '8.90', priceValue: 8.90 }) }),
        domain: 'grip6.com',
        features: {},
        destinationChecks: OK_CHECKS
    });
    assert.equal(above.signal_type, SIGNAL_TYPES.PRICE_MISMATCH);
});

test('price mismatch thresholds are configurable via audit features', async () => {
    const snapshot = makeSnapshot({ review_signals: {} });
    const signal = await runSignalWaterfall({
        snapshot,
        // delta $8.02 < 20% of $74.97
        observation: makeObservation(),
        domain: 'grip6.com',
        features: { priceMismatchMinDeltaPct: 20, priceMismatchMinDeltaUsd: 0.75 },
        destinationChecks: OK_CHECKS
    });
    assert.equal(signal.signal_type, SIGNAL_TYPES.AD_MATCH);
});

test('buildSignalExportVars formats prices and maps issue labels', () => {
    const vars = buildSignalExportVars({
        signalType: SIGNAL_TYPES.PRICE_MISMATCH,
        observed: { ad_price: 66.95 },
        expected: { page_price: 74.97 },
        snapshot: makeSnapshot(),
        adCard: makeAdCard()
    });
    assert.equal(vars.issue, 'price mismatch');
    assert.equal(vars.ad_price, '$66.95');
    assert.equal(vars.page_price, '$74.97');
    assert.equal(vars.ad_price_value, 66.95);
    assert.equal(vars.page_price_value, 74.97);
});

test('formatPriceUsd trims whole-dollar cents and handles null', () => {
    assert.equal(formatPriceUsd(66.95), '$66.95');
    assert.equal(formatPriceUsd(80), '$80');
    assert.equal(formatPriceUsd('74.90'), '$74.90');
    assert.equal(formatPriceUsd(null), '');
});

test('precomputeDestinationChecks returns empty map when no ad links', async () => {
    const map = await precomputeDestinationChecks([
        { branch: 'none', matched_card: null },
        { branch: 'clean', matched_card: {} }
    ]);
    assert.equal(map.size, 0);
});

test('binary matched=true drives hasAd without any branch field', async () => {
    const snapshot = makeSnapshot({
        variants: [{ price: '66.95', available: true }],
        review_signals: {}
    });
    const signal = await runSignalWaterfall({
        snapshot,
        observation: {
            matched: true,
            seller_match_method: 'concat',
            matched_card: makeAdCard(),
            all_cards: []
        },
        domain: 'grip6.com',
        features: {},
        destinationChecks: OK_CHECKS
    });

    assert.equal(signal.signal_type, SIGNAL_TYPES.AD_MATCH);
    assert.equal(signal.observed.matched, true);
    assert.equal(signal.observed.seller_match_method, 'concat');
});

test('explicit matched=false overrides a stale clean branch', async () => {
    const snapshot = makeSnapshot({ title: 'Socks', review_signals: {} });
    const signal = await runSignalWaterfall({
        snapshot,
        observation: { matched: false, branch: 'clean', matched_card: makeAdCard(), all_cards: [] },
        domain: 'grip6.com',
        features: {},
        destinationChecks: OK_CHECKS
    });

    // No ad → only the title-quality fallback is eligible.
    assert.equal(signal.signal_type, SIGNAL_TYPES.TITLE_QUALITY);
});

test('legacy observations without matched fall back to branch inference', async () => {
    const snapshot = makeSnapshot({
        variants: [{ price: '66.95', available: true }],
        review_signals: {}
    });
    const signal = await runSignalWaterfall({
        snapshot,
        observation: makeObservation(),
        domain: 'grip6.com',
        features: {},
        destinationChecks: OK_CHECKS
    });

    assert.equal(signal.signal_type, SIGNAL_TYPES.AD_MATCH);
});

test('runSignalWaterfallStage compares the ad against the matched product, not the hero', async () => {
    const heroSnapshot = makeSnapshot({ title: 'Hero Product', variants: [{ price: '10.00', available: true }] });
    const matchedProduct = makeSnapshot({
        title: 'Merino Wool Crew Sock 3-Pack',
        variants: [{ price: '74.97', available: true }],
        review_signals: {}
    });
    const emissions = await runSignalWaterfallStage({
        selectionsWithObservations: [{
            domain: 'grip6.com',
            selection: { domain: 'grip6.com', snapshot: heroSnapshot },
            matched: true,
            matched_product: matchedProduct,
            matched_card: makeAdCard(),
            all_cards: [],
            observed_at: '2026-07-17T00:00:00.000Z'
        }],
        features: {},
        enableBrokenPage: false
    });

    assert.equal(emissions.length, 1);
    const { signal } = emissions[0];
    // Price mismatch computed against the matched product ($74.97), not the hero ($10).
    assert.equal(signal.signal_type, SIGNAL_TYPES.PRICE_MISMATCH);
    assert.equal(signal.export_vars.product, 'Merino Wool Crew Sock 3-Pack');
    assert.equal(signal.export_vars.page_price, '$74.97');
});

test('runSignalWaterfallStage falls back to the hero snapshot for legacy unmatched rows', async () => {
    const heroSnapshot = makeSnapshot({ title: 'Socks', review_signals: {} });
    const emissions = await runSignalWaterfallStage({
        selectionsWithObservations: [{
            domain: 'grip6.com',
            selection: { domain: 'grip6.com', snapshot: heroSnapshot },
            matched: false,
            matched_product: null,
            matched_card: null,
            all_cards: []
        }],
        features: {},
        enableBrokenPage: false
    });

    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].signal.signal_type, SIGNAL_TYPES.TITLE_QUALITY);
});

test('runSignalWaterfallStage emits nothing for unmatched serper-first rows — they do not move forward', async () => {
    const emissions = await runSignalWaterfallStage({
        selectionsWithObservations: [{
            domain: 'grip6.com',
            matched: false,
            matched_product: null,
            matched_card: null,
            all_cards: []
        }],
        features: {},
        enableBrokenPage: false
    });

    assert.equal(emissions.length, 0);
});

test('runSignalWaterfallStage supplies the matched product as the personalization selection', async () => {
    const matchedProduct = makeSnapshot({ title: 'Merino Wool Crew Sock 3-Pack' });
    const emissions = await runSignalWaterfallStage({
        selectionsWithObservations: [{
            domain: 'grip6.com',
            matched: true,
            matched_product: matchedProduct,
            matched_card: makeAdCard({ price: '74.97', priceValue: 74.97 }),
            all_cards: []
        }],
        features: {},
        enableBrokenPage: false
    });

    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].selection.snapshot.title, 'Merino Wool Crew Sock 3-Pack');
});

test('price mismatch compares against the variant closest to the ad price, not the cheapest', async () => {
    // Gift-card style product: denominations $10–$100 as variants. Ad shows the
    // $50 card — the page agrees, so no mismatch.
    const snapshot = makeSnapshot({
        variants: [
            { price: '10.00', available: true },
            { price: '25.00', available: true },
            { price: '50.00', available: true },
            { price: '100.00', available: true }
        ],
        review_signals: {}
    });
    const agree = await runSignalWaterfall({
        snapshot,
        observation: makeObservation({ matched_card: makeAdCard({ price: '50.00', priceValue: 50 }) }),
        domain: 'grip6.com',
        features: {},
        destinationChecks: OK_CHECKS
    });
    assert.equal(agree.signal_type, SIGNAL_TYPES.AD_MATCH);

    // Ad price far from every variant still fires, against the closest one.
    const mismatch = await runSignalWaterfall({
        snapshot,
        observation: makeObservation({ matched_card: makeAdCard({ price: '70.00', priceValue: 70 }) }),
        domain: 'grip6.com',
        features: {},
        destinationChecks: OK_CHECKS
    });
    assert.equal(mismatch.signal_type, SIGNAL_TYPES.PRICE_MISMATCH);
    assert.equal(mismatch.expected.page_price, 50);
});

test('precomputeDestinationChecks excludes links when matched=false despite a clean branch', async () => {
    const map = await precomputeDestinationChecks([
        { matched: false, branch: 'clean', matched_card: { link: AD_LINK } }
    ]);
    assert.equal(map.size, 0);
});

test('google redirect links never fire broken_page (rate-limited 429s are not broken pages)', async () => {
    const googleLink = 'https://www.google.com/search?ibp=oshop&q=grip6.com&prds=x';
    const snapshot = makeSnapshot({
        variants: [{ price: '66.95', available: true }],
        review_signals: {}
    });
    const signal = await runSignalWaterfall({
        snapshot,
        observation: {
            matched: true,
            matched_card: makeAdCard({ link: googleLink }),
            all_cards: []
        },
        domain: 'grip6.com',
        features: {},
        destinationChecks: new Map([[googleLink, { broken: true, reason: 'http_error', statusCode: 429 }]])
    });
    assert.equal(signal.signal_type, SIGNAL_TYPES.AD_MATCH);

    // And precompute never even queues google links for checking.
    const map = await precomputeDestinationChecks([
        { matched: true, matched_card: { link: googleLink } }
    ]);
    assert.equal(map.size, 0);
});
