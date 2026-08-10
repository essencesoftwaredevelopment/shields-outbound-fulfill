import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanizeProductShort } from '../utils.js';

test('empty and placeholder inputs return empty string', () => {
    assert.equal(humanizeProductShort(''), '');
    assert.equal(humanizeProductShort(null), '');
    assert.equal(humanizeProductShort(undefined), '');
    assert.equal(humanizeProductShort('   '), '');
    assert.equal(humanizeProductShort('(SALE)'), '');
});

test('always below 35 characters', () => {
    const samples = [
        'Kimtrue - 3rd-Generation Makeup Meltaway Cleansing Balm, Hydrating Makeup Melting Balm with Plant-Based Ingredients, Makeup Balm Remover for Waterproof Makeup, Makeup Removing Balm 3.38 oz',
        'ROYALE LINENS 300 Thread Count 100% Long Staple Combed Cotton Printed Sheet Set - 4 Piece Bed Sheet - 1 Fitted Sheet, 1 Flat Sheet, 2 Pillow case -Cool & Crisp Sheet Set (Stripe Burgundy)',
        'Supercalifragilisticexpialidociously-Long-Single-Token-Product-Name-Without-Spaces',
        'A short name'
    ];
    for (const s of samples) {
        assert.ok(humanizeProductShort(s).length < 35, `${s} -> ${humanizeProductShort(s)}`);
    }
});

test('ALL CAPS titles become sentence case', () => {
    assert.equal(
        humanizeProductShort('SPRINTER VAN PLATFORM BED SYSTEM'),
        'Sprinter van platform bed system'
    );
    assert.equal(humanizeProductShort('NOTES HOLDER'), 'Notes holder');
    assert.equal(humanizeProductShort('TYMO AIRBEAM PINK'), 'Tymo airbeam pink');
});

test('mixed-case titles keep the merchant casing', () => {
    assert.equal(humanizeProductShort('Original Bag Organizer'), 'Original Bag Organizer');
    assert.equal(humanizeProductShort('Ghostly Garlic Fusion Hot Sauce'), 'Ghostly Garlic Fusion Hot Sauce');
    assert.equal(humanizeProductShort('Talc Free Body Powder, Unscented'), 'Talc Free Body Powder, Unscented');
});

test('truncates at word boundaries without dangling connectors', () => {
    const result = humanizeProductShort(
        'Locsanity Loc Cleanse and Moisturize Bundle - Rosewater & Peppermint 2-in-1 Shampoo Conditioner'
    );
    assert.equal(result, 'Locsanity Loc Cleanse');
    const brush = humanizeProductShort(
        'Candy Brush Curl Defining Hair Brush for Effortlessly Detangling & Blow Drying'
    );
    assert.ok(brush.length < 35);
    assert.ok(!/[\s\-|,:;&+]$/.test(brush));
});

test('strips bracketed variant and marketing segments', () => {
    assert.equal(
        humanizeProductShort('TickleMe Plant Seed Packets (2-Pack) - Fun'),
        'TickleMe Plant Seed Packets - Fun'
    );
    assert.equal(
        humanizeProductShort('Pet Expertise™ Collagen (FREE Shipping)'),
        'Pet Expertise Collagen'
    );
    assert.equal(
        humanizeProductShort('Stir Of Beauty Unflavored Lip Balm ( LIMITED DROP )'),
        'Stir Of Beauty Unflavored Lip Balm'
    );
});

test('strips marketing junk words and phrases', () => {
    assert.equal(humanizeProductShort('Houndstooth Denim Fanny Pack-SALE'), 'Houndstooth Denim Fanny Pack');
    assert.equal(humanizeProductShort('*BACK IN STOCK* Busy doing hot ghoul sh*t Graphic Tee'), 'Busy doing hot ghoul sh*t Graphic');
    assert.equal(humanizeProductShort('Devine Gardens worm castings - subscribe for 20% off'), 'Devine Gardens worm castings');
    assert.equal(humanizeProductShort('NEW Hoodie'), 'Hoodie');
});

test('"New" is kept in brand collocations, stripped as filler', () => {
    assert.equal(
        humanizeProductShort("Sole Classics x New Era 59Fifty Fitted Hat 20 Years Pack 'Black/Gold'"),
        'Sole Classics x New Era 59Fifty'
    );
    assert.equal(humanizeProductShort('New Era 59Fifty Fitted Hat'), 'New Era 59Fifty Fitted Hat');
    assert.equal(
        humanizeProductShort('Colored New Wine Glass Set Large 12 Oz Glasses'),
        'Colored Wine Glass Set Large 12 Oz'
    );
});

test('idempotent — applying twice equals applying once', () => {
    const samples = [
        'SPRINTER VAN PLATFORM BED SYSTEM',
        'Kimtrue - 3rd-Generation Makeup Meltaway Cleansing Balm, Hydrating',
        'Houndstooth Denim Fanny Pack-SALE',
        'socks',
        'Original Bag Organizer'
    ];
    for (const s of samples) {
        const once = humanizeProductShort(s);
        assert.equal(humanizeProductShort(once), once, `not idempotent for: ${s}`);
    }
});

test('legacy LLM values pass through unchanged', () => {
    assert.equal(humanizeProductShort('socks'), 'socks');
    assert.equal(humanizeProductShort('protein bars'), 'protein bars');
});
