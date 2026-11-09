import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clearDoNotEmailCache,
    doNotEmailSql,
    emailDomainIsBlocked,
    everWonSql,
    findDoNotEmailEmails,
    isContactDoNotEmail,
    normalizeBlockedDomain
} from '../doNotEmail.js';
import { addLeadsToInstantlyCampaign } from '../instantlyUpload.js';

test('won means a lead_closed event or Instantly status 4 / "won", by contact or same email in the client', () => {
    const sql = everWonSql('$1');
    assert.match(sql, /event_type = 'lead_closed'/);
    assert.match(sql, /interest_status = 4/);
    assert.match(sql, /= 'won'/);
    assert.match(sql, /won_any\.client_id = won_self\.client_id/);
});

test('do-not-email covers won leads and blocked email or company domains', () => {
    const sql = doNotEmailSql('$1');
    assert.match(sql, /lead_closed/);
    assert.match(sql, /unnest\(bd_cl\.blocked_domains\)/);
    assert.match(sql, /bd_co\.domain_normalized/);
});

test('blocked domains match exactly or as a subdomain, never as a suffix of another name', () => {
    const blocked = ['spicywear.com'];
    assert.equal(emailDomainIsBlocked('John@SpicyWear.com', blocked), true);
    assert.equal(emailDomainIsBlocked('a@shop.spicywear.com', blocked), true);
    assert.equal(emailDomainIsBlocked('a@notspicywear.com', blocked), false);
    assert.equal(emailDomainIsBlocked('', blocked), false);
});

test('pasted domains are normalized', () => {
    assert.equal(normalizeBlockedDomain(' https://www.AngelRuche.com/collections/x '), 'angelruche.com');
    assert.equal(normalizeBlockedDomain('linearbar.com.'), 'linearbar.com');
});

test('findDoNotEmailEmails matches won emails, blocked email domains and blocked company domains in memory', async () => {
    clearDoNotEmailCache();
    const calls = [];
    const lookedUp = [];
    const db = {
        query: async (sql, params) => {
            calls.push(sql);
            if (sql.includes('SELECT blocked_domains')) return { rows: [{ blocked_domains: ['spicywear.com', 'linearbar.com'] }] };
            if (sql.includes('lead_closed')) return { rows: [{ email: 'won@gmail.com' }] };
            // company-domain lookup, for exactly the emails being checked
            lookedUp.push([...params[1]].sort());
            return { rows: [{ email: 'owner@gmail.com', domain: 'shop.linearbar.com' }, { email: 'ok@shop.com', domain: 'shop.com' }] };
        }
    };
    const found = await findDoNotEmailEmails(db, 2, ['John@spicywear.com', 'owner@gmail.com', 'ok@shop.com', 'WON@gmail.com']);
    assert.deepEqual([...found].sort(), ['john@spicywear.com', 'owner@gmail.com', 'won@gmail.com']);
    assert.deepEqual(lookedUp[0], ['john@spicywear.com', 'ok@shop.com', 'owner@gmail.com', 'won@gmail.com']);
    assert.equal((await findDoNotEmailEmails(db, 2, [])).size, 0);

    // The list is cached: a second call only runs the company-domain lookup.
    const before = calls.length;
    await findDoNotEmailEmails(db, 2, ['ok@shop.com']);
    assert.equal(calls.length - before, 1);
    clearDoNotEmailCache();
});

test('no blocked domains means no company lookup', async () => {
    clearDoNotEmailCache();
    let lookups = 0;
    const db = {
        query: async (sql) => {
            if (sql.includes('SELECT blocked_domains')) return { rows: [{ blocked_domains: [] }] };
            if (sql.includes('lead_closed')) return { rows: [] };
            lookups += 1;
            return { rows: [] };
        }
    };
    assert.equal((await findDoNotEmailEmails(db, 9, ['a@b.com'])).size, 0);
    assert.equal(lookups, 0);
    clearDoNotEmailCache();
});

test('isContactDoNotEmail reads the flag', async () => {
    assert.equal(await isContactDoNotEmail({ query: async () => ({ rows: [{ blocked: true }] }) }, 7), true);
    assert.equal(await isContactDoNotEmail({ query: async () => ({ rows: [{ blocked: false }] }) }, 7), false);
    assert.equal(await isContactDoNotEmail({ query: async () => { throw new Error('no'); } }, null), false);
});

test('adding leads to an Instantly campaign refuses to run without a client to check', async () => {
    await assert.rejects(
        addLeadsToInstantlyCampaign({ instantlyKey: 'k', campaignId: 'c', leads: [{ email: 'a@x.com' }] }),
        /needs clientId/
    );
});
