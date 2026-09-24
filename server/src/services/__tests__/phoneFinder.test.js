import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    decidePhoneAction,
    findPhoneForContact,
    normalizeLinkedinProfileUrl,
    splitFullName
} from '../phoneFinder.js';

describe('decidePhoneAction', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');

    it('never searches a contact that has a number or a final miss', () => {
        assert.equal(decidePhoneAction({ phone: '+15555550100' }, now), 'have');
        assert.equal(decidePhoneAction({ phone_status: 'found' }, now), 'skip');
        assert.equal(decidePhoneAction({ phone_status: 'not_found' }, now), 'skip');
    });

    it('resumes a paid search instead of launching another', () => {
        assert.equal(decidePhoneAction({ phone_status: 'timeout', phone_search_id: 's1' }, now), 'resume');
        assert.equal(decidePhoneAction({ phone_status: 'pending', phone_search_id: 's1' }, now), 'resume');
    });

    it('leaves a fresh claim alone but re-claims a stale one', () => {
        const fresh = { phone_status: 'pending', phone_checked_at: new Date(now - 60_000).toISOString() };
        const stale = { phone_status: 'pending', phone_checked_at: new Date(now - 11 * 60_000).toISOString() };
        assert.equal(decidePhoneAction(fresh, now), 'skip');
        assert.equal(decidePhoneAction(stale, now), 'search');
    });

    it('searches when never tried or the last submit errored', () => {
        assert.equal(decidePhoneAction({}, now), 'search');
        assert.equal(decidePhoneAction({ phone_status: 'error' }, now), 'search');
    });
});

describe('splitFullName', () => {
    it('needs a first and last name', () => {
        assert.deepEqual(splitFullName('  Jane   van der Berg '), { firstName: 'Jane', lastName: 'van der Berg' });
        assert.equal(splitFullName('Jane'), null);
        assert.equal(splitFullName(null), null);
    });
});

describe('normalizeLinkedinProfileUrl', () => {
    it('canonicalizes profile URLs', () => {
        assert.equal(
            normalizeLinkedinProfileUrl('https://ca.linkedin.com/in/jane-doe-123?trk=x'),
            'https://www.linkedin.com/in/jane-doe-123/'
        );
        assert.equal(
            normalizeLinkedinProfileUrl('linkedin.com/in/jane-doe/details/'),
            'https://www.linkedin.com/in/jane-doe/'
        );
    });

    it('rejects anything that is not a person profile', () => {
        assert.equal(normalizeLinkedinProfileUrl('https://www.linkedin.com/company/acme/'), null);
        assert.equal(normalizeLinkedinProfileUrl('https://evil-linkedin.com/in/jane/'), null);
        assert.equal(normalizeLinkedinProfileUrl('not a url'), null);
        assert.equal(normalizeLinkedinProfileUrl(null), null);
    });
});

/**
 * In-memory stand-in for the contacts row: answers the finder's handful of
 * queries and applies its UPDATEs so assertions can read the final state.
 */
function fakeDb(row) {
    const state = { ...row };
    const calls = [];
    return {
        state,
        calls,
        async query(sql, params) {
            calls.push({ sql, params });
            if (/^\s*SELECT/i.test(sql)) return { rows: [{ ...state }], rowCount: 1 };
            if (/phone_status = 'pending',/.test(sql)) {
                const claimable = !state.phone
                    && (state.phone_status == null || state.phone_status === 'error');
                if (!claimable) return { rows: [], rowCount: 0 };
                Object.assign(state, { phone_status: 'pending', phone_search_id: null });
                return { rows: [{ id: state.id }], rowCount: 1 };
            }
            if (/SET phone_search_id = \$2/.test(sql)) {
                Object.assign(state, { phone_search_id: params[1], phone_search_input: params[2], phone_credits_used: params[3] });
            } else if (/phone_status = 'found'/.test(sql)) {
                Object.assign(state, { phone: params[1], phone_country: params[2], phone_source: 'enrow', phone_status: 'found' });
            } else if (/phone_status = 'not_found'/.test(sql)) {
                state.phone_status = 'not_found';
            } else if (/phone_status = 'timeout'/.test(sql)) {
                state.phone_status = 'timeout';
            } else if (/phone_status = 'error'/.test(sql)) {
                Object.assign(state, { phone_status: 'error', phone_error: params[1] });
            }
            return { rows: [], rowCount: 1 };
        }
    };
}

const baseContact = {
    id: 7,
    full_name: 'Jane Doe',
    email: 'jane@acme.com',
    company_domain: 'acme.com',
    phone: null,
    phone_status: null,
    phone_search_id: null
};
const enabledSettings = { enrow_key: 'ek', serper_key: 'sk', openai_key: 'ok', features: { enrowPhoneLookup: true } };

function deps(overrides = {}) {
    let clock = 0;
    const submits = [];
    return {
        submits,
        deps: {
            getAgencySettings: async () => enabledSettings,
            searchLead: async () => ({ url: 'https://uk.linkedin.com/in/jane-doe', confidence: 0.9 }),
            submitEnrowPhoneFind: async (key, search) => {
                submits.push(search);
                return { id: 'srch-1', creditsUsed: 50 };
            },
            getEnrowPhone: async () => ({ qualification: 'found', number: '+15705551234', country: 'US' }),
            refreshCredits: async () => {},
            sleep: async (ms) => {
                clock += ms;
            },
            now: () => clock,
            ...overrides
        }
    };
}

const quiet = () => {};

describe('findPhoneForContact', () => {
    it('does nothing unless the agency opted in with its own key', async () => {
        const db = fakeDb(baseContact);
        const { deps: d } = deps({ getAgencySettings: async () => ({ enrow_key: 'ek', features: {} }) });
        const res = await findPhoneForContact({ agencyId: 'a', contactId: 7, db, logger: quiet, deps: d });
        assert.equal(res.status, 'disabled');
        assert.equal(db.calls.length, 0);
    });

    it('searches by a confident LinkedIn match and stores the number', async () => {
        const db = fakeDb(baseContact);
        const { deps: d, submits } = deps();
        const res = await findPhoneForContact({ agencyId: 'a', contactId: 7, db, logger: quiet, deps: d });
        assert.deepEqual(res, { status: 'found', number: '+15705551234', country: 'US' });
        assert.deepEqual(submits, [{ linkedinUrl: 'https://www.linkedin.com/in/jane-doe/', custom: 'contact:7' }]);
        assert.equal(db.state.phone, '+15705551234');
        assert.equal(db.state.phone_search_id, 'srch-1');
        assert.equal(db.state.phone_search_input, 'linkedin');
    });

    it('falls back to name + domain when the LinkedIn match is weak', async () => {
        const db = fakeDb(baseContact);
        const { deps: d, submits } = deps({
            searchLead: async () => ({ url: 'https://www.linkedin.com/in/someone-else', confidence: 0.3 })
        });
        await findPhoneForContact({ agencyId: 'a', contactId: 7, db, logger: quiet, deps: d });
        assert.deepEqual(submits, [{ firstName: 'Jane', lastName: 'Doe', companyDomain: 'acme.com', custom: 'contact:7' }]);
        assert.equal(db.state.phone_search_input, 'name');
    });

    it('retries by name when Enrow rejects the LinkedIn URL', async () => {
        const db = fakeDb(baseContact);
        const submits = [];
        const { deps: d } = deps({
            submitEnrowPhoneFind: async (key, search) => {
                submits.push(search);
                if (search.linkedinUrl) throw Object.assign(new Error('Invalid linkedin_url format'), { status: 400 });
                return { id: 'srch-2', creditsUsed: 50 };
            }
        });
        const res = await findPhoneForContact({ agencyId: 'a', contactId: 7, db, logger: quiet, deps: d });
        assert.equal(res.status, 'found');
        assert.equal(submits.length, 2);
        assert.equal(submits[1].firstName, 'Jane');
    });

    it('records a miss so the contact is never billed again', async () => {
        const db = fakeDb(baseContact);
        const { deps: d } = deps({ getEnrowPhone: async () => ({ qualification: 'not_found' }) });
        assert.equal((await findPhoneForContact({ agencyId: 'a', contactId: 7, db, logger: quiet, deps: d })).status, 'not_found');
        assert.equal(db.state.phone_status, 'not_found');

        const { deps: d2, submits } = deps();
        const again = await findPhoneForContact({ agencyId: 'a', contactId: 7, db, logger: quiet, deps: d2 });
        assert.equal(again.status, 'skipped');
        assert.equal(submits.length, 0);
    });

    it('marks a failed submit as a retryable error', async () => {
        const db = fakeDb(baseContact);
        const { deps: d } = deps({
            submitEnrowPhoneFind: async () => {
                throw Object.assign(new Error('Enrow 402: Insufficient credits'), { status: 402, code: 'ENROW_CREDIT_EXHAUSTED' });
            }
        });
        const res = await findPhoneForContact({ agencyId: 'a', contactId: 7, db, logger: quiet, deps: d });
        assert.deepEqual(res, { status: 'error', reason: 'ENROW_CREDIT_EXHAUSTED' });
        assert.equal(db.state.phone_status, 'error');
        assert.equal(decidePhoneAction(db.state), 'search');
    });

    it('stops polling at the deadline and resumes the same search next time', async () => {
        const db = fakeDb(baseContact);
        const { deps: d } = deps({ getEnrowPhone: async () => ({ qualification: 'ongoing' }) });
        const res = await findPhoneForContact({ agencyId: 'a', contactId: 7, db, logger: quiet, timeoutMs: 30_000, deps: d });
        assert.equal(res.status, 'timeout');
        assert.equal(db.state.phone_status, 'timeout');

        const polled = [];
        const { deps: d2, submits } = deps({
            getEnrowPhone: async (key, id) => {
                polled.push(id);
                return { qualification: 'found', number: '+15705551234', country: 'US' };
            }
        });
        const resumed = await findPhoneForContact({ agencyId: 'a', contactId: 7, db, logger: quiet, deps: d2 });
        assert.equal(resumed.status, 'found');
        assert.equal(submits.length, 0);
        assert.deepEqual(polled, ['srch-1']);
    });

    it('skips without spending when there is no LinkedIn match and no full name', async () => {
        const db = fakeDb({ ...baseContact, full_name: 'Jane' });
        const { deps: d, submits } = deps({ searchLead: async () => ({ url: null, confidence: 0 }) });
        const res = await findPhoneForContact({ agencyId: 'a', contactId: 7, db, logger: quiet, deps: d });
        assert.deepEqual(res, { status: 'error', reason: 'no_search_input' });
        assert.equal(submits.length, 0);
    });
});
