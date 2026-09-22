import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    enrowBulkStatus,
    mapEnrowFindResults,
    mapEnrowVerifyResults
} from '../enrow.js';

describe('enrowBulkStatus', () => {
    it('reads general.status and treats anything unfinished as ongoing', () => {
        assert.equal(enrowBulkStatus({ general: { status: 'completed' } }), 'completed');
        assert.equal(enrowBulkStatus({ general: { status: 'failed' } }), 'failed');
        assert.equal(enrowBulkStatus({ general: { status: 'ongoing' } }), 'ongoing');
        assert.equal(enrowBulkStatus(null), 'ongoing');
    });
});

describe('mapEnrowFindResults', () => {
    const items = [{ contact_id: '11' }, { contact_id: '12' }, { contact_id: '13' }];

    it('keeps only valid hits, keyed by custom, falling back to index', () => {
        const body = {
            general: { status: 'completed' },
            stats: { credits_cost: { initial: 3, refunded: 1, final: 2 } },
            results: [
                { index: '0', qualification: 'valid', email: 'jane@a.com', custom: '11' },
                { index: '1', qualification: 'invalid', custom: '12' },
                { index: '2', qualification: 'valid', email: 'john@c.com' }
            ]
        };
        const { found, credits } = mapEnrowFindResults(body, items);
        assert.deepEqual(found, [
            { contactId: '11', email: 'jane@a.com' },
            { contactId: '13', email: 'john@c.com' }
        ]);
        assert.deepEqual(credits, { initial: 3, final: 2 });
    });

    it('drops malformed emails, unknown indexes and duplicate contacts', () => {
        const body = {
            results: [
                { index: '0', qualification: 'valid', email: 'not-an-email', custom: '11' },
                { index: '9', qualification: 'valid', email: 'x@y.com' },
                { index: '1', qualification: 'valid', email: 'a@b.com', custom: '12' },
                { index: '1', qualification: 'valid', email: 'a2@b.com', custom: '12' }
            ]
        };
        assert.deepEqual(mapEnrowFindResults(body, items).found, [{ contactId: '12', email: 'a@b.com' }]);
    });
});

describe('mapEnrowVerifyResults', () => {
    it('matches verdicts back by email, case-insensitively', () => {
        const items = [
            { contact_id: '1', email: 'Jane@A.com' },
            { contact_id: '2', email: 'b@b.com' },
            { contact_id: '3', email: 'c@c.com' }
        ];
        const body = {
            stats: { credits_cost: 0.75 },
            results: [
                { email: 'jane@a.com', qualification: 'valid' },
                { email: 'b@b.com', qualification: 'invalid' },
                { email: 'c@c.com', qualification: 'ongoing' },
                { email: 'stranger@x.com', qualification: 'valid' }
            ]
        };
        const { verdicts, credits } = mapEnrowVerifyResults(body, items);
        assert.deepEqual(verdicts, [
            { contactId: '1', status: 'valid' },
            { contactId: '2', status: 'invalid' }
        ]);
        assert.equal(credits.final, 0.75);
    });
});
