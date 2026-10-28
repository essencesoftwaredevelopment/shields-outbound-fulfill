import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCloseLeadPayload, syncCloseLeadForContact } from '../closeLeadSync.js';
import { closeLeadUrl } from '../close.js';
import { closeLeadsEnabled } from '../db/agencySettings.js';
import { ntfyCallActionHeader } from '../interestedAutoResponder.js';

const SETTINGS = { close_key: 'api_test', features: { closeLeads: true } };
const CONTACT = {
    id: 7,
    full_name: 'Jane Doe',
    email: 'Jane@Acme.com',
    role_type: 'founder',
    phone: '+15705551234',
    company_domain: 'acme-goods.com',
    attributes: { companyName: 'Acme Goods' },
    close_lead_id: null,
    close_contact_id: null,
    close_phone: null
};

/** Fake pg: answers the contact SELECT and the claim, records every UPDATE. */
function fakeDb(contact, { claim = true } = {}) {
    const updates = [];
    return {
        updates,
        async query(sql, params) {
            if (/^\s*SELECT/i.test(sql)) return { rows: contact ? [contact] : [], rowCount: contact ? 1 : 0 };
            if (/close_status = 'pending'/.test(sql) && /RETURNING id/.test(sql)) {
                return { rows: claim ? [{ id: contact.id }] : [], rowCount: claim ? 1 : 0 };
            }
            updates.push({ sql, params });
            return { rows: [], rowCount: 1 };
        }
    };
}

function fakeClose(overrides = {}) {
    const calls = [];
    const record = (name, result) => async (...args) => {
        calls.push([name, ...args.slice(1)]);
        return typeof result === 'function' ? result(...args) : result;
    };
    return {
        calls,
        deps: {
            getAgencySettings: async () => SETTINGS,
            findCloseLeadIdByEmail: record('find', null),
            findCloseLeadStatusId: record('status', (_key, label) => (label === 'Potential' ? 'stat_potential' : null)),
            getCloseLead: record('getLead', { id: 'lead_x', contacts: [] }),
            createCloseLead: record('createLead', { leadId: 'lead_new', contactId: 'cont_new' }),
            createCloseContact: record('createContact', 'cont_added'),
            addPhoneToCloseContact: record('addPhone', true),
            createCloseNote: record('note', 'acti_1'),
            ...overrides
        }
    };
}

const quiet = () => {};

describe('buildCloseLeadPayload', () => {
    it('maps the contact to a Close lead with the founder as contact', () => {
        assert.deepEqual(buildCloseLeadPayload(CONTACT, { campaignName: 'Q4 ecom' }), {
            name: 'Acme Goods',
            url: 'https://acme-goods.com',
            description: 'Positive reply — Q4 ecom',
            contact: { name: 'Jane Doe', title: 'Founder', email: 'jane@acme.com', phone: '+15705551234' }
        });
    });

    it('falls back to the domain for the company and the email domain for the site', () => {
        const payload = buildCloseLeadPayload({ email: 'sam@shop-co.io', full_name: null, attributes: null });
        assert.equal(payload.name, 'Shop Co');
        assert.equal(payload.url, 'https://shop-co.io');
        assert.equal(payload.contact.name, null);
        assert.equal(payload.contact.phone, null);
    });
});

describe('closeLeadsEnabled', () => {
    it('needs the key and the flag, and respects the client allowlist', () => {
        assert.equal(closeLeadsEnabled(SETTINGS, 2), true);
        assert.equal(closeLeadsEnabled({ ...SETTINGS, close_key: ' ' }, 2), false);
        assert.equal(closeLeadsEnabled({ close_key: 'k', features: {} }, 2), false);
        const scoped = { close_key: 'k', features: { closeLeads: true, closeClients: { ids: '2, 5' } } };
        assert.equal(closeLeadsEnabled(scoped, 5), true);
        assert.equal(closeLeadsEnabled(scoped, 24), false);
    });
});

describe('syncCloseLeadForContact', () => {
    it('creates the lead with a note and stores the ids', async () => {
        const db = fakeDb({ ...CONTACT });
        const close = fakeClose();
        const result = await syncCloseLeadForContact({
            agencyId: 'a1', contactId: 7, clientId: 2, campaignName: 'Q4', replyText: '<p>Sounds good, call me</p>',
            db, logger: quiet, deps: close.deps
        });
        assert.deepEqual(result, { status: 'created', leadId: 'lead_new', url: closeLeadUrl('lead_new') });
        assert.deepEqual(close.calls.map((c) => c[0]), ['find', 'status', 'createLead', 'note']);
        assert.equal(close.calls[2][1].statusId, 'stat_potential');
        assert.match(close.calls[3][2], /Positive reply \(Q4\)\n\nSounds good, call me/);
        const stored = db.updates.at(-1);
        assert.match(stored.sql, /close_status = 'synced'/);
        assert.deepEqual(stored.params, [7, 'lead_new', 'cont_new', '+15705551234']);
    });

    it('links an existing Close lead with that email instead of creating one', async () => {
        const db = fakeDb({ ...CONTACT });
        const close = fakeClose({
            findCloseLeadIdByEmail: async () => 'lead_old',
            getCloseLead: async () => ({ id: 'lead_old', contacts: [{ id: 'cont_old', emails: [{ email: 'jane@acme.com' }] }] })
        });
        const result = await syncCloseLeadForContact({ agencyId: 'a1', contactId: 7, db, logger: quiet, deps: close.deps });
        assert.equal(result.status, 'linked');
        assert.equal(result.leadId, 'lead_old');
        assert.deepEqual(close.calls.find((c) => c[0] === 'addPhone'), ['addPhone', 'cont_old', '+15705551234']);
        assert.equal(close.calls.some((c) => c[0] === 'createLead' || c[0] === 'status'), false);
        assert.deepEqual(db.updates.at(-1).params.slice(1, 3), ['lead_old', 'cont_old']);
    });

    it('only tops up a phone found after the lead was created', async () => {
        const db = fakeDb({ ...CONTACT, close_lead_id: 'lead_1', close_contact_id: 'cont_1', close_phone: null });
        const close = fakeClose();
        const result = await syncCloseLeadForContact({ agencyId: 'a1', contactId: 7, db, logger: quiet, deps: close.deps });
        assert.deepEqual(result, { status: 'exists', leadId: 'lead_1', url: closeLeadUrl('lead_1') });
        assert.deepEqual(close.calls, [['addPhone', 'cont_1', '+15705551234']]);

        const same = fakeDb({ ...CONTACT, close_lead_id: 'lead_1', close_contact_id: 'cont_1', close_phone: '+15705551234' });
        const idle = fakeClose();
        await syncCloseLeadForContact({ agencyId: 'a1', contactId: 7, db: same, logger: quiet, deps: idle.deps });
        assert.deepEqual(idle.calls, []);
    });

    it('is disabled without the flag, and skips when another run holds the claim', async () => {
        const off = fakeClose({ getAgencySettings: async () => ({ close_key: 'k', features: {} }) });
        assert.deepEqual(
            await syncCloseLeadForContact({ agencyId: 'a1', contactId: 7, db: fakeDb(CONTACT), logger: quiet, deps: off.deps }),
            { status: 'disabled' }
        );
        const forced = await syncCloseLeadForContact({
            agencyId: 'a1', contactId: 7, force: true, db: fakeDb({ ...CONTACT }), logger: quiet, deps: off.deps
        });
        assert.equal(forced.status, 'created');

        const busy = fakeClose();
        const result = await syncCloseLeadForContact({
            agencyId: 'a1', contactId: 7, db: fakeDb(CONTACT, { claim: false }), logger: quiet, deps: busy.deps
        });
        assert.deepEqual(result, { status: 'skipped', reason: 'claimed_elsewhere' });
        assert.deepEqual(busy.calls, []);
    });

    it('uses the configured status, and the org default when Close has no such status', async () => {
        const custom = fakeClose({
            getAgencySettings: async () => ({ ...SETTINGS, features: { closeLeads: true, closeLeadStatus: { label: 'Hot' } } })
        });
        await syncCloseLeadForContact({ agencyId: 'a1', contactId: 7, db: fakeDb({ ...CONTACT }), logger: quiet, deps: custom.deps });
        assert.deepEqual(custom.calls.find((c) => c[0] === 'status'), ['status', 'Hot']);
        assert.equal(custom.calls.find((c) => c[0] === 'createLead')[1].statusId, null);
    });

    it('records the error and never throws when Close fails', async () => {
        const db = fakeDb({ ...CONTACT });
        const close = fakeClose({
            createCloseLead: async () => {
                const err = new Error('Close 401: bad key');
                err.code = 'CLOSE_UNAUTHORIZED';
                throw err;
            }
        });
        const result = await syncCloseLeadForContact({ agencyId: 'a1', contactId: 7, db, logger: quiet, deps: close.deps });
        assert.deepEqual(result, { status: 'error', reason: 'CLOSE_UNAUTHORIZED' });
        assert.match(db.updates.at(-1).sql, /close_status = 'error'/);
    });

    it('creates anyway when the email search errors (not auth)', async () => {
        const close = fakeClose({
            findCloseLeadIdByEmail: async () => {
                throw new Error('Close 400: bad query');
            }
        });
        const result = await syncCloseLeadForContact({
            agencyId: 'a1', contactId: 7, db: fakeDb({ ...CONTACT }), logger: quiet, deps: close.deps
        });
        assert.equal(result.status, 'created');
    });
});

describe('ntfyCallActionHeader with Close', () => {
    it('adds a Close button, with or without a phone', () => {
        const url = closeLeadUrl('lead_1');
        assert.deepEqual(ntfyCallActionHeader(null, url), { Actions: `view, Close, ${url}` });
        assert.match(ntfyCallActionHeader({ number: '+15705551234' }, url).Actions, /Text, sms:\+15705551234; view, Close, /);
    });
});
