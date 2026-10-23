import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addSendingDays, campaignScheduleDays, computeSendingRunway } from '../sendingRunway.js';

const weekdays = { campaign_schedule: { schedules: [{ days: { 1: true, 2: true, 3: true, 4: true, 5: true } }] } };
const threeSteps = { sequences: [{ steps: [{}, {}, {}] }] };
const account = (email, dailyLimit, status = 1) => ({ email, daily_limit: dailyLimit, status });

// Thursday 23 Oct 2026
const now = new Date('2026-10-23T12:00:00Z');

describe('addSendingDays', () => {
    it('counts today and skips weekends', () => {
        assert.equal(addSendingDays(now, 1, [1, 2, 3, 4, 5]), '2026-10-23');
        assert.equal(addSendingDays(now, 2, [1, 2, 3, 4, 5]), '2026-10-26');
        assert.equal(addSendingDays(now, 2.3, [1, 2, 3, 4, 5]), '2026-10-27');
    });
});

describe('campaignScheduleDays', () => {
    it('reads enabled weekdays and defaults to Mon–Fri', () => {
        assert.deepEqual(campaignScheduleDays({ campaign_schedule: { schedules: [{ days: { 0: true, 6: true, 3: false } }] } }), [0, 6]);
        assert.deepEqual(campaignScheduleDays({}), [1, 2, 3, 4, 5]);
    });
});

describe('computeSendingRunway', () => {
    const accounts = [
        account('a@x.com', 30),
        account('b@x.com', 30),
        account('c@x.com', 30),
        account('paused@x.com', 30, 2)
    ];

    it('derives new leads/day from tagged inboxes, campaign cap and steps', () => {
        const result = computeSendingRunway({
            campaigns: [{
                id: 'c1', name: 'Main', status: 1, email_tag_list: ['t1'], email_list: ['c@x.com'],
                daily_limit: 1000, ...threeSteps, ...weekdays
            }],
            accounts,
            taggedEmails: new Map([['t1', ['A@x.com', 'b@x.com', 'paused@x.com']]]),
            backlog: new Map([['c1', { notContacted: 90, inSequence: 12 }]]),
            reserve: { verified: 60, withFirstLine: 10 },
            now
        });
        const [row] = result.campaigns;
        assert.equal(row.inboxes, 3); // paused inbox excluded
        assert.equal(row.sendsPerDay, 90);
        assert.equal(row.newLeadsPerDay, 30); // a third of volume
        assert.equal(row.limitedBy, 'inboxes');
        assert.equal(row.runwayDays, 3);
        assert.equal(row.runsDryOn, '2026-10-27');
        assert.equal(result.totals.reserve.extraDays, 2);
        assert.equal(result.totals.totalRunwayDays, 5);
        assert.equal(result.totals.totalRunsDryOn, '2026-10-29');
        assert.deepEqual(result.warnings, []);
    });

    it('applies daily_max_leads and campaign daily_limit caps', () => {
        const result = computeSendingRunway({
            campaigns: [
                { id: 'cap', name: 'Capped', status: 1, email_list: ['a@x.com'], daily_max_leads: 5, ...threeSteps },
                { id: 'lim', name: 'Limited', status: 1, email_list: ['b@x.com'], daily_limit: 12, ...threeSteps }
            ],
            accounts,
            taggedEmails: new Map(),
            backlog: new Map(),
            reserve: { verified: 0, withFirstLine: 0 },
            now
        });
        const byId = Object.fromEntries(result.campaigns.map((row) => [row.id, row]));
        assert.equal(byId.cap.newLeadsPerDay, 5);
        assert.equal(byId.cap.limitedBy, 'daily_max_leads');
        assert.equal(byId.lim.sendsPerDay, 12);
        assert.equal(byId.lim.newLeadsPerDay, 4);
        assert.equal(byId.lim.limitedBy, 'campaign_daily_limit');
    });

    it('splits a shared inbox across active campaigns and ignores paused ones in totals', () => {
        const result = computeSendingRunway({
            campaigns: [
                { id: 'c1', name: 'One', status: 1, email_list: ['a@x.com'], ...threeSteps },
                { id: 'c2', name: 'Two', status: 1, email_list: ['a@x.com', 'b@x.com'], ...threeSteps },
                { id: 'p', name: 'Paused', status: 2, email_list: ['c@x.com'], ...threeSteps }
            ],
            accounts,
            taggedEmails: new Map(),
            backlog: new Map([['p', { notContacted: 500, inSequence: 0 }]]),
            reserve: { verified: 0, withFirstLine: 0 },
            now
        });
        const byId = Object.fromEntries(result.campaigns.map((row) => [row.id, row]));
        assert.equal(byId.c1.sendsPerDay, 15);
        assert.equal(byId.c1.sharedInboxes, 1);
        assert.equal(byId.c2.sendsPerDay, 45);
        assert.equal(result.totals.inboxes, 2);
        assert.equal(result.totals.pausedBacklog, 500);
        assert.equal(result.totals.backlog, 0);
        assert.equal(byId.p.runwayDays, null);
    });

    it('warns when an active campaign has no usable inboxes', () => {
        const result = computeSendingRunway({
            campaigns: [{ id: 'c1', name: 'Empty', status: 1 }],
            accounts,
            taggedEmails: new Map(),
            backlog: new Map([['c1', { notContacted: 10, inSequence: 0 }]]),
            reserve: { verified: 0, withFirstLine: 0 },
            now
        });
        assert.equal(result.campaigns[0].newLeadsPerDay, 0);
        assert.equal(result.totals.totalRunwayDays, null);
        assert.ok(result.warnings.some((warning) => /no inboxes assigned/.test(warning)));
    });
});
