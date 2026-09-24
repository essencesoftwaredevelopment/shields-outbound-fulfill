import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    ntfyCallActionHeader,
    sendNtfyNotification,
    serializeReviewPhone,
    telUriForPhone
} from '../interestedAutoResponder.js';

describe('telUriForPhone', () => {
    it('keeps a leading + and strips formatting', () => {
        assert.equal(telUriForPhone('+1 (570) 555-1234'), 'tel:+15705551234');
        assert.equal(telUriForPhone('0203 555 0100'), 'tel:02035550100');
    });

    it('rejects values too short to dial', () => {
        assert.equal(telUriForPhone('+12'), null);
        assert.equal(telUriForPhone(null), null);
    });
});

describe('ntfyCallActionHeader', () => {
    it('adds a Call button only with a number', () => {
        assert.deepEqual(ntfyCallActionHeader({ number: '+15705551234' }), { Actions: 'view, Call, tel:+15705551234' });
        assert.deepEqual(ntfyCallActionHeader(null), {});
    });
});

describe('serializeReviewPhone', () => {
    it('returns the number with a tel link', () => {
        assert.deepEqual(
            serializeReviewPhone({ contact_phone: '+15705551234', contact_phone_country: 'US', contact_phone_status: 'found' }),
            { number: '+15705551234', country: 'US', telUri: 'tel:+15705551234', status: 'found' }
        );
    });

    it('returns only the lookup state without a number, and null when never looked up', () => {
        assert.deepEqual(
            serializeReviewPhone({ contact_phone: null, contact_phone_status: 'not_found' }),
            { number: null, country: null, telUri: null, status: 'not_found' }
        );
        assert.equal(serializeReviewPhone({}), null);
    });
});

describe('sendNtfyNotification phone line', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it('adds the phone line and Call action when a number is known', async () => {
        const calls = [];
        globalThis.fetch = async (url, init) => {
            calls.push(init);
            return new Response('{}', { status: 200 });
        };
        await sendNtfyNotification('topic', {
            leadEmail: 'jane@acme.com',
            campaignName: 'C',
            reviewUrl: 'https://x/r',
            phone: { number: '+15705551234', country: 'US' }
        });
        await sendNtfyNotification('topic', { leadEmail: 'jane@acme.com', campaignName: 'C', reviewUrl: 'https://x/r' });
        assert.match(calls[0].body, /Phone: \+15705551234 \(US\)/);
        assert.equal(calls[0].headers.Actions, 'view, Call, tel:+15705551234');
        assert.doesNotMatch(calls[1].body, /Phone:/);
        assert.equal(calls[1].headers.Actions, undefined);
    });
});
