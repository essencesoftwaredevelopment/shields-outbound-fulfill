import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_LEAD_LIST_CONTACT_IDS,
    MAX_LEAD_LIST_NAME_LENGTH,
    normalizeLeadListName,
    parseContactIds,
    parseLeadListId
} from '../leadLists.js';

describe('normalizeLeadListName', () => {
    it('trims and collapses whitespace', () => {
        assert.equal(normalizeLeadListName('  Q2  founders  '), 'Q2 founders');
    });

    it('returns null for blank names', () => {
        assert.equal(normalizeLeadListName(''), null);
        assert.equal(normalizeLeadListName('   '), null);
        assert.equal(normalizeLeadListName(null), null);
    });

    it('caps length', () => {
        const name = normalizeLeadListName('x'.repeat(MAX_LEAD_LIST_NAME_LENGTH + 20));
        assert.equal(name.length, MAX_LEAD_LIST_NAME_LENGTH);
    });
});

describe('parseLeadListId', () => {
    it('accepts positive integers', () => {
        assert.equal(parseLeadListId('12'), 12);
        assert.equal(parseLeadListId(7), 7);
    });

    it('rejects invalid ids', () => {
        assert.equal(parseLeadListId('0'), null);
        assert.equal(parseLeadListId('-3'), null);
        assert.equal(parseLeadListId('abc'), null);
        assert.equal(parseLeadListId(''), null);
    });
});

describe('parseContactIds', () => {
    it('dedupes and drops invalid values', () => {
        assert.deepEqual(parseContactIds(['1', 1, '2', 'nope', 0, -4, '3']), [1, 2, 3]);
    });

    it('caps at MAX_LEAD_LIST_CONTACT_IDS', () => {
        const ids = Array.from({ length: MAX_LEAD_LIST_CONTACT_IDS + 10 }, (_, i) => i + 1);
        assert.equal(parseContactIds(ids).length, MAX_LEAD_LIST_CONTACT_IDS);
    });
});
