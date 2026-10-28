import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    instantlyReplyRecipientFields,
    normalizeReplyRecipients
} from '../interestedAutoResponder.js';

describe('normalizeReplyRecipients', () => {
    it('returns empty lists when nothing is given', () => {
        assert.deepEqual(normalizeReplyRecipients(), { to: [], cc: [], bcc: [] });
        assert.deepEqual(normalizeReplyRecipients({ to: '', cc: '  ', bcc: [] }), { to: [], cc: [], bcc: [] });
    });

    it('splits comma, semicolon and whitespace separated strings, lowercases and dedupes', () => {
        const result = normalizeReplyRecipients({
            to: 'Anna@Shop.com, bob@shop.com;anna@shop.com',
            cc: 'carl@shop.com dana@shop.com',
            bcc: ['ops@agency.io']
        });
        assert.deepEqual(result, {
            to: ['anna@shop.com', 'bob@shop.com'],
            cc: ['carl@shop.com', 'dana@shop.com'],
            bcc: ['ops@agency.io']
        });
    });

    it('drops the lead, the sending inbox, and addresses already used by an earlier list', () => {
        const result = normalizeReplyRecipients(
            {
                to: 'lead@shop.com, partner@shop.com',
                cc: 'partner@shop.com, me@agency.io, boss@shop.com',
                bcc: 'boss@shop.com, log@agency.io'
            },
            { leadEmail: 'Lead@Shop.com', eaccount: 'me@agency.io' }
        );
        assert.deepEqual(result, {
            to: ['partner@shop.com'],
            cc: ['boss@shop.com'],
            bcc: ['log@agency.io']
        });
    });

    it('rejects an invalid address with a 400 naming the field', () => {
        assert.throws(
            () => normalizeReplyRecipients({ cc: 'ok@shop.com, not-an-email' }),
            (error) => error.statusCode === 400 && /not-an-email/.test(error.message) && /Cc/.test(error.message)
        );
    });

    it('caps each list at 10 addresses', () => {
        const eleven = Array.from({ length: 11 }, (_, i) => `p${i}@shop.com`).join(',');
        assert.throws(
            () => normalizeReplyRecipients({ bcc: eleven }),
            (error) => error.statusCode === 400 && /Bcc/.test(error.message)
        );
    });
});

describe('instantlyReplyRecipientFields', () => {
    it('omits every field when there are no extra recipients', () => {
        assert.deepEqual(instantlyReplyRecipientFields({ to: [], cc: [], bcc: [] }), {});
        assert.deepEqual(instantlyReplyRecipientFields(), {});
    });

    it('maps to Instantly field names and shapes', () => {
        assert.deepEqual(
            instantlyReplyRecipientFields({
                to: ['a@x.com'],
                cc: ['b@x.com', 'c@x.com'],
                bcc: ['d@x.com']
            }),
            {
                additional_recipients: ['a@x.com'],
                cc_address_email_list: 'b@x.com,c@x.com',
                bcc_address_email_list: 'd@x.com'
            }
        );
    });
});
