import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bestCatalogMatch,
    brandRootLabel,
    cardToProductSimilarity,
    matchSellerToBrand
} from '../utils.js';

test('brandRootLabel returns the brand label for plain domains', () => {
    assert.equal(brandRootLabel('spicywear.com'), 'spicywear');
    assert.equal(brandRootLabel('www.gymshark.com'), 'gymshark');
    assert.equal(brandRootLabel('https://grip6.com/products/socks'), 'grip6');
});

test('brandRootLabel survives two-level ccTLDs (domainRootLabel returns "com")', () => {
    assert.equal(brandRootLabel('silvershop.com.au'), 'silvershop');
    assert.equal(brandRootLabel('simplyrosepetals.com.au'), 'simplyrosepetals');
    assert.equal(brandRootLabel('foo.co.uk'), 'foo');
    assert.equal(brandRootLabel('bar.net.nz'), 'bar');
});

test('matchSellerToBrand: substring hit on host or root', () => {
    assert.deepEqual(matchSellerToBrand('grip6.com', 'grip6.com'), { matched: true, method: 'substring' });
    assert.deepEqual(matchSellerToBrand('Spicywear Official', 'spicywear.com'), { matched: true, method: 'substring' });
});

test('matchSellerToBrand: space-insensitive concat hit the legacy matcher misses', () => {
    assert.deepEqual(matchSellerToBrand('Spicy Wear', 'spicywear.com'), { matched: true, method: 'concat' });
    assert.deepEqual(matchSellerToBrand('Sleepy Head USA', 'sleepyheadusa.com'), { matched: true, method: 'concat' });
});

test('matchSellerToBrand: falls through to legacy token similarity', () => {
    // Hyphenated brand: concat "simpleshot" ≠ "simple-shot", but tokenized
    // similarity is exact — the legacy sellerMatchesDomain tier catches it.
    assert.deepEqual(matchSellerToBrand('Simple Shot', 'simple-shot.com'), { matched: true, method: 'legacy_similarity' });
});

test('matchSellerToBrand: misses and empty sellers', () => {
    assert.deepEqual(matchSellerToBrand('Amazon.com', 'spicywear.com'), { matched: false, method: null });
    assert.deepEqual(matchSellerToBrand('', 'spicywear.com'), { matched: false, method: null });
    assert.deepEqual(matchSellerToBrand(null, 'spicywear.com'), { matched: false, method: null });
    // ccTLD brand must not false-positive on sellers containing "com"
    assert.deepEqual(matchSellerToBrand('Randomcompany Store', 'silvershop.com.au'), { matched: false, method: null });
});

test('cardToProductSimilarity strips brand tokens and scores lenient vs strict', () => {
    const sim = cardToProductSimilarity(
        'Grip6 Merino Wool Sock',
        'Merino Wool Sock 3-Pack',
        'grip6'
    );
    // card tokens {merino, wool, sock}, product tokens {merino, wool, sock, 3, pack}
    assert.equal(sim.lenient, 1);
    assert.equal(sim.strict, 0.6);
});

test('cardToProductSimilarity guards empty token sets', () => {
    assert.deepEqual(cardToProductSimilarity('', 'Merino Wool Sock', 'grip6'), { lenient: 0, strict: 0 });
    assert.deepEqual(cardToProductSimilarity('Grip6', 'Grip6', 'grip6'), { lenient: 0, strict: 0 });
});

test('bestCatalogMatch picks the highest lenient similarity with strict tiebreak', () => {
    const snapshots = [
        { title: 'Merino Wool Sock 3-Pack Bundle Deal', product_id: 1 },
        { title: 'Merino Wool Sock', product_id: 2 },
        { title: 'Leather Belt', product_id: 3 },
        { title: '', product_id: 4 }
    ];
    const best = bestCatalogMatch({ title: 'Merino Wool Sock' }, snapshots, 'grip6');
    // Both sock products score lenient 1.0; the exact title wins on strict.
    assert.equal(best.snapshot.product_id, 2);
    assert.equal(best.similarity_lenient, 1);
    assert.equal(best.similarity_strict, 1);
});

test('bestCatalogMatch returns null for empty or titleless catalogs', () => {
    assert.equal(bestCatalogMatch({ title: 'Merino Wool Sock' }, [], 'grip6'), null);
    assert.equal(bestCatalogMatch({ title: 'Merino Wool Sock' }, [{ title: '' }], 'grip6'), null);
});

test('short model designators distinguish sibling products (sire-usa regression)', () => {
    // "L3"/"L5"/"LH" are 2-char tokens — dropping them scored the wrong
    // sibling at 1.0 and produced a false price_mismatch signal.
    const wrongSibling = cardToProductSimilarity(
        'Sire Larry Carlton L3 P90',
        'Sire Larry Carlton L5 LH',
        'sire-usa'
    );
    assert.ok(wrongSibling.lenient < 0.6, `expected < 0.6, got ${wrongSibling.lenient}`);

    const catalog = [
        { title: 'Sire Larry Carlton L5 LH', product_id: 1 },
        { title: 'Sire Larry Carlton L5', product_id: 2 },
        { title: 'Sire Larry Carlton L3 HH', product_id: 3 },
        { title: 'Sire Larry Carlton L3 P90 LH', product_id: 4 },
        { title: 'Sire Larry Carlton L3 P90', product_id: 5 }
    ];
    const best = bestCatalogMatch({ title: 'Sire Larry Carlton L3 P90' }, catalog, 'sire-usa');
    assert.equal(best.snapshot.product_id, 5);
    assert.equal(best.similarity_lenient, 1);
});

test('disjoint digit tokens veto sibling products even with short titles', () => {
    // Second sire-usa false positive: short product title let a wrong sibling
    // through at 0.75 despite differing model numbers.
    const sim = cardToProductSimilarity(
        'Sire Marcus Miller D5 Alder 4-String Electric Bass Guitar',
        'Sire Marcus Miller P7 4-String',
        'sire-usa'
    );
    assert.deepEqual(sim, { lenient: 0, strict: 0 });

    // Quantity variants are siblings too.
    const packs = cardToProductSimilarity('Merino Sock 12-Pack', 'Merino Sock 24-Pack', 'grip6');
    assert.deepEqual(packs, { lenient: 0, strict: 0 });

    // Shared digit token → no veto (same product, extra descriptors).
    const same = cardToProductSimilarity(
        'Sire Larry Carlton L3 P90 Electric Guitar',
        'Sire Larry Carlton L3 P90',
        'sire-usa'
    );
    assert.equal(same.lenient, 1);

    // Digit tokens on one side only → no veto (title omits variant details).
    const oneSided = cardToProductSimilarity('iPad Air M2 256GB', 'iPad Air M2', 'apple');
    assert.equal(oneSided.lenient, 1);
});

test('single-digit designators distinguish siblings but do not trip the model veto', () => {
    // "4-String" vs "5-String": shared model token (v5, 24) so no veto, but the
    // differing single digit must keep strict below the settle threshold so
    // pagination continues to the advertised product.
    const sim = cardToProductSimilarity(
        'Sire Marcus Miller V5-24 4-String',
        'Sire Marcus Miller V5-24 5-String',
        'sire-usa'
    );
    assert.ok(sim.lenient < 1, `expected < 1, got ${sim.lenient}`);
    assert.ok(sim.strict < 0.9, `expected < 0.9, got ${sim.strict}`);

    const exact = cardToProductSimilarity(
        'Sire Marcus Miller V5-24 4-String',
        'Sire Marcus Miller V5-24 4-String',
        'sire-usa'
    );
    assert.equal(exact.lenient, 1);
    assert.equal(exact.strict, 1);

    // Disjoint pure numbers still veto ("iPhone 15" vs "iPhone 14").
    const phones = cardToProductSimilarity('iPhone 15 Case', 'iPhone 14 Case', 'apple');
    assert.deepEqual(phones, { lenient: 0, strict: 0 });
});
