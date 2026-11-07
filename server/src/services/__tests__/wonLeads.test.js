import test from 'node:test';
import assert from 'node:assert/strict';
import { everWonSql, findEverWonEmails, isContactEverWon } from '../wonLeads.js';
import { addLeadsToInstantlyCampaign } from '../instantlyUpload.js';

test('won means a lead_closed event or Instantly status 4 / "won", by contact or same email in the client', () => {
    const sql = everWonSql('$1');
    assert.match(sql, /event_type = 'lead_closed'/);
    assert.match(sql, /interest_status = 4/);
    assert.match(sql, /= 'won'/);
    assert.match(sql, /won_any\.client_id = won_self\.client_id/);
});

test('findEverWonEmails lowercases and skips the query when there is nothing to check', async () => {
    let calls = 0;
    const db = { query: async (_sql, params) => { calls += 1; assert.deepEqual(params[1], ['a@x.com']); return { rows: [{ email: 'a@x.com' }] }; } };
    assert.deepEqual([...await findEverWonEmails(db, 2, [' A@x.com ', 'a@x.com', ''])], ['a@x.com']);
    assert.equal((await findEverWonEmails(db, 2, [])).size, 0);
    assert.equal(calls, 1);
});

test('isContactEverWon reads the flag', async () => {
    assert.equal(await isContactEverWon({ query: async () => ({ rows: [{ won: true }] }) }, 7), true);
    assert.equal(await isContactEverWon({ query: async () => ({ rows: [{ won: false }] }) }, 7), false);
    assert.equal(await isContactEverWon({ query: async () => { throw new Error('no'); } }, null), false);
});

test('adding leads to an Instantly campaign refuses to run without a client to check', async () => {
    await assert.rejects(
        addLeadsToInstantlyCampaign({ instantlyKey: 'k', campaignId: 'c', leads: [{ email: 'a@x.com' }] }),
        /needs clientId/
    );
});
