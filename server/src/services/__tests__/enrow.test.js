import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    enrowBulkStatus,
    getEnrowPhone,
    mapEnrowFindResults,
    mapEnrowPhoneResult,
    mapEnrowVerifyResults,
    submitEnrowPhoneFind
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

describe('mapEnrowPhoneResult', () => {
    it('reads a found number and upper-cases the country', () => {
        assert.deepEqual(
            mapEnrowPhoneResult(200, { qualification: 'found', number: '+15705551234', country: 'us' }),
            { qualification: 'found', number: '+15705551234', country: 'US' }
        );
    });

    it('treats 202 / ongoing / empty bodies as still running', () => {
        assert.equal(mapEnrowPhoneResult(202, { qualification: 'ongoing' }).qualification, 'ongoing');
        assert.equal(mapEnrowPhoneResult(200, { qualification: 'ongoing' }).qualification, 'ongoing');
        assert.equal(mapEnrowPhoneResult(200, null).qualification, 'ongoing');
    });

    it('never reports a found without a usable number', () => {
        assert.equal(mapEnrowPhoneResult(200, { qualification: 'not_found' }).qualification, 'not_found');
        assert.equal(mapEnrowPhoneResult(200, { qualification: 'found', number: '' }).qualification, 'not_found');
        assert.equal(mapEnrowPhoneResult(200, { qualification: 'found', number: '12' }).qualification, 'not_found');
    });
});

describe('Enrow phone requests', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    function mockFetch(status, body) {
        const calls = [];
        globalThis.fetch = async (url, init) => {
            calls.push({ url, init });
            return new Response(JSON.stringify(body), { status });
        };
        return calls;
    }

    it('sends linkedin_url alone when present (it wins over the name)', async () => {
        const calls = mockFetch(201, { id: 'abc', credits_used: 50 });
        const res = await submitEnrowPhoneFind('k', {
            linkedinUrl: 'https://www.linkedin.com/in/jane/',
            firstName: 'Jane',
            lastName: 'Doe',
            companyDomain: 'acme.com',
            custom: 'contact:7'
        });
        assert.deepEqual(res, { id: 'abc', creditsUsed: 50 });
        assert.equal(calls[0].url, 'https://api.enrow.io/phone/single');
        assert.equal(calls[0].init.headers['x-api-key'], 'k');
        assert.deepEqual(JSON.parse(calls[0].init.body), {
            linkedin_url: 'https://www.linkedin.com/in/jane/',
            custom: 'contact:7'
        });
    });

    it('uses firstname / lastname / company_domain without a LinkedIn URL', async () => {
        const calls = mockFetch(201, { id: 'abc', credits_used: 50 });
        await submitEnrowPhoneFind('k', { firstName: 'Jane', lastName: 'Doe', companyDomain: 'acme.com' });
        assert.deepEqual(JSON.parse(calls[0].init.body), {
            firstname: 'Jane',
            lastname: 'Doe',
            company_domain: 'acme.com'
        });
    });

    it('flags a plan without phone search apart from a bad key', async () => {
        mockFetch(401, { message: 'This account is not allowed to use the phone search feature' });
        await assert.rejects(
            submitEnrowPhoneFind('k', { linkedinUrl: 'https://www.linkedin.com/in/jane/' }),
            (err) => err.code === 'ENROW_PHONE_NOT_ALLOWED' && err.status === 401
        );
        mockFetch(401, { message: 'This apikey is not valid' });
        await assert.rejects(
            submitEnrowPhoneFind('k', { linkedinUrl: 'https://www.linkedin.com/in/jane/' }),
            (err) => err.code === 'ENROW_UNAUTHORIZED'
        );
    });

    it('maps a 202 poll to ongoing and a 200 to the number', async () => {
        mockFetch(202, { qualification: 'ongoing' });
        assert.equal((await getEnrowPhone('k', 'abc')).qualification, 'ongoing');
        const calls = mockFetch(200, { qualification: 'found', number: '+447700900123', country: 'GB' });
        assert.deepEqual(await getEnrowPhone('k', 'a b'), {
            qualification: 'found', number: '+447700900123', country: 'GB'
        });
        assert.equal(calls[0].url, 'https://api.enrow.io/phone/single?id=a%20b');
    });
});
