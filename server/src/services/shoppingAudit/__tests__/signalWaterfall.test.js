import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildSignalExportVars,
    precomputeDestinationChecks,
    runSignalWaterfall
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
