import test from 'node:test';
import assert from 'node:assert/strict';
import {
    cacheEntryFromObservation,
    matchDomainCards,
    SERPER_CACHE_VERSION
} from '../serperShopping.js';

const DOMAIN = 'grip6.com';

function card(overrides = {}) {
    return {
        title: 'Merino Wool Sock',
        price: '$66.95',
        source: 'grip6.com',
        link: 'https://grip6.com/products/merino-socks',
        ...overrides
    };
}

function snapshot(title, productId) {
    return {
        domain_normalized: DOMAIN,
        title,
        product_id: productId,
        handle: title.toLowerCase().replace(/\s+/g, '-'),
        variants: [{ price: '74.97', available: true }],
        review_signals: {}
    };
}

function fetchPageStub(pages) {
    const calls = [];
    const fetch = async (page) => {
        calls.push(page);
        return pages[page] || [];
    };
    fetch.calls = calls;
    return fetch;
}

test('matchDomainCards fetches page 1 on demand and matches a seller card', async () => {
    const fetchCatalogPage = fetchPageStub({
        1: [snapshot('Merino Wool Sock', 1), snapshot('Leather Belt', 2)]
    });
    const result = await matchDomainCards({
        domain: DOMAIN,
        cards: [card(), card({ title: 'Rival Sock', source: 'rival.com' })],
        fetchCatalogPage,
        pageLimit: 50
    });

    assert.equal(result.matched, true);
    assert.equal(result.sellerCards, 1);
    assert.equal(result.best.method, 'substring');
    assert.equal(result.best.match.snapshot.product_id, 1);
    assert.equal(result.pagesFetched, 1);
    // page-1 rows are returned for persistence
    assert.equal(result.fetchedSnapshots.length, 2);
    assert.deepEqual(fetchCatalogPage.calls, [1]);
});

test('matchDomainCards never touches the catalog when no card seller matches', async () => {
    const fetchCatalogPage = fetchPageStub({
        1: [snapshot('Merino Wool Sock', 1)]
    });
    const result = await matchDomainCards({
        domain: DOMAIN,
        cards: [card({ source: 'amazon.com' }), card({ source: 'walmart.com' })],
        fetchCatalogPage
    });

    assert.equal(result.matched, false);
    assert.equal(result.best, null);
    assert.equal(result.sellerCards, 0);
    assert.equal(result.pagesFetched, 0);
    assert.deepEqual(fetchCatalogPage.calls, []);
});

test('matchDomainCards paginates until the card matches and returns all fetched rows', async () => {
    const page1 = [snapshot('Leather Belt', 1), snapshot('Canvas Bag', 2)];
    const page2 = [snapshot('Wool Beanie', 3), snapshot('Merino Wool Sock', 4)];
    const fetchCatalogPage = fetchPageStub({ 1: page1, 2: page2 });

    const result = await matchDomainCards({
        domain: DOMAIN,
        cards: [card()],
        fetchCatalogPage,
        pageLimit: 2,
        maxPages: 10
    });

    assert.equal(result.matched, true);
    assert.equal(result.best.match.snapshot.product_id, 4);
    assert.equal(result.pagesFetched, 2);
    assert.deepEqual(fetchCatalogPage.calls, [1, 2]);
    assert.deepEqual(result.fetchedSnapshots, [...page1, ...page2]);
});

test('matchDomainCards stops on a short page (catalog exhausted)', async () => {
    const fetchCatalogPage = fetchPageStub({
        1: [snapshot('Leather Belt', 1), snapshot('Canvas Bag', 2)],
        2: [snapshot('Wool Beanie', 3)],
        3: [snapshot('Merino Wool Sock', 4)]
    });

    const result = await matchDomainCards({
        domain: DOMAIN,
        cards: [card()],
        fetchCatalogPage,
        pageLimit: 2,
        maxPages: 10
    });

    assert.equal(result.matched, false);
    // page 3 exists in the stub but must never be requested after a short page 2
    assert.deepEqual(fetchCatalogPage.calls, [1, 2]);
});

test('matchDomainCards stops at maxPages', async () => {
    const fullPage = (n) => [snapshot(`Leather Belt ${n}A`, n * 10), snapshot(`Canvas Bag ${n}B`, n * 10 + 1)];
    const fetchCatalogPage = fetchPageStub({ 1: fullPage(1), 2: fullPage(2), 3: fullPage(3), 4: fullPage(4) });

    const result = await matchDomainCards({
        domain: DOMAIN,
        cards: [card()],
        fetchCatalogPage,
        pageLimit: 2,
        maxPages: 3
    });

    assert.equal(result.matched, false);
    assert.equal(result.pagesFetched, 3);
    assert.deepEqual(fetchCatalogPage.calls, [1, 2, 3]);
});

test('matchDomainCards treats an empty/unreachable catalog as unmatched (not Shopify)', async () => {
    const fetchCatalogPage = fetchPageStub({});
    const result = await matchDomainCards({
        domain: DOMAIN,
        cards: [card()],
        fetchCatalogPage,
        pageLimit: 50
    });

    assert.equal(result.matched, false);
    assert.equal(result.pagesFetched, 1);
    assert.deepEqual(fetchCatalogPage.calls, [1]);
});

test('matchDomainCards keeps paginating past a passable sibling until a near-exact match', async () => {
    // Page 1 has the "LH" sibling — passes the lenient threshold (all 4 card
    // tokens present) but is not the advertised product, which sits on page 2.
    const page1 = [snapshot('Larry Carlton L3 P90 LH', 1), snapshot('Leather Belt', 2)];
    const page2 = [snapshot('Larry Carlton L3 P90', 3), snapshot('Canvas Bag', 4)];
    const fetchCatalogPage = fetchPageStub({ 1: page1, 2: page2 });

    const result = await matchDomainCards({
        domain: DOMAIN,
        cards: [card({ title: 'Larry Carlton L3 P90' })],
        fetchCatalogPage,
        pageLimit: 2,
        maxPages: 10
    });

    assert.equal(result.matched, true);
    assert.equal(result.best.match.snapshot.product_id, 3);
    assert.equal(result.best.match.similarity_strict, 1);
    assert.deepEqual(fetchCatalogPage.calls, [1, 2]);
});

test('matchDomainCards caps candidates at maxSellerCards but counts all seller cards', async () => {
    const cards = Array.from({ length: 8 }, (_, i) => card({ title: `Merino Wool Sock ${i}` }));
    const result = await matchDomainCards({
        domain: DOMAIN,
        cards,
        fetchCatalogPage: fetchPageStub({ 1: [snapshot('Merino Wool Sock', 1)] }),
        maxSellerCards: 5
    });

    assert.equal(result.sellerCards, 8);
    assert.equal(result.candidates, 5);
});

test('cacheEntryFromObservation writes a v2 payload with the binary match fields', () => {
    const entry = cacheEntryFromObservation({
        domain: DOMAIN,
        query: DOMAIN,
        matched: true,
        matched_card: card(),
        matched_product: snapshot('Merino Wool Sock', 1),
        matched_snapshot_id: 42,
        seller_match_method: 'substring',
        match_similarity: 1,
        catalog_pages_fetched: 2,
        branch: 'clean',
        all_cards: [card()],
        source: 'serper',
        geo: { gl: 'us' },
        observed_at: '2026-07-17T00:00:00.000Z'
    });

    assert.equal(SERPER_CACHE_VERSION, 2);
    assert.equal(entry.payload.version, SERPER_CACHE_VERSION);
    assert.equal(entry.payload.matched, true);
    assert.equal(entry.payload.matched_product.product_id, 1);
    assert.equal(entry.payload.matched_snapshot_id, 42);
    assert.equal(entry.payload.seller_match_method, 'substring');
    assert.equal(entry.payload.match_similarity, 1);
    assert.equal(entry.payload.catalog_pages_fetched, 2);
    assert.equal(entry.payload.branch, 'clean');
});
