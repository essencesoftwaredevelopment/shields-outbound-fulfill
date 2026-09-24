import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    ntfyCallActionHeader,
    phoneLinksForPhone,
    sendNtfyNotification,
    serializeReviewPhone
} from '../interestedAutoResponder.js';

const LINKS = { facetime: 'facetime-audio://+15705551234', sms: 'sms:+15705551234' };
const ACTIONS = 'view, FaceTime, facetime-audio://+15705551234; view, Text, sms:+15705551234';

describe('phoneLinksForPhone', () => {
    it('keeps a leading + and strips formatting', () => {
        assert.deepEqual(phoneLinksForPhone('+1 (570) 555-1234'), LINKS);
        assert.deepEqual(phoneLinksForPhone('0203 555 0100'), {
            facetime: 'facetime-audio://02035550100',
            sms: 'sms:02035550100'
        });
    });

    it('rejects values too short to dial', () => {
        assert.equal(phoneLinksForPhone('+12'), null);
        assert.equal(phoneLinksForPhone(null), null);
    });
});

describe('ntfyCallActionHeader', () => {
    it('adds FaceTime and Text buttons only with a number', () => {
        assert.deepEqual(ntfyCallActionHeader({ number: '+15705551234' }), { Actions: ACTIONS });
        assert.deepEqual(ntfyCallActionHeader(null), {});
    });
});

describe('serializeReviewPhone', () => {
    it('returns the number with FaceTime and SMS links', () => {
        assert.deepEqual(
            serializeReviewPhone({ contact_phone: '+15705551234', contact_phone_country: 'US', contact_phone_status: 'found' }),
            { number: '+15705551234', country: 'US', links: LINKS, status: 'found' }
        );
    });

    it('returns only the lookup state without a number, and null when never looked up', () => {
        assert.deepEqual(
            serializeReviewPhone({ contact_phone: null, contact_phone_status: 'not_found' }),
            { number: null, country: null, links: null, status: 'not_found' }
        );
        assert.equal(serializeReviewPhone({}), null);
    });
});

describe('sendNtfyNotification phone line', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it('adds the phone line and FaceTime/Text actions when a number is known', async () => {
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
        assert.equal(calls[0].headers.Actions, ACTIONS);
        assert.doesNotMatch(calls[1].body, /Phone:/);
        assert.equal(calls[1].headers.Actions, undefined);
    });
});
