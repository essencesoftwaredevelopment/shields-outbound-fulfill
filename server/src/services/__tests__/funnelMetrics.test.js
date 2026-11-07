import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolvePeriod,
    countWorkingDays,
    proratedCostLines,
    computeSalesMetrics,
    buildScriptRows,
    DAYS_PER_MONTH
} from '../funnelMetrics.js';
import { normalizeSalesCall } from '../db/funnelInputs.js';

// Monday 2026-11-02, 15:00 UTC
const NOW = new Date('2026-11-02T15:00:00Z');

test('resolvePeriod: rolling 7 days ends tomorrow 00:00 UTC', () => {
    const period = resolvePeriod('7d', NOW);
    assert.equal(period.start.toISOString(), '2026-10-27T00:00:00.000Z');
    assert.equal(period.end.toISOString(), '2026-11-03T00:00:00.000Z');
    assert.equal(period.days, 7);
    assert.equal(period.workingDays, 5);
});

test('resolvePeriod: last week is the previous Mon–Sun', () => {
    const period = resolvePeriod('last_week', NOW);
    assert.equal(period.start.toISOString(), '2026-10-26T00:00:00.000Z');
    assert.equal(period.end.toISOString(), '2026-11-02T00:00:00.000Z');
    assert.equal(period.workingDays, 5);
});

test('resolvePeriod: last month and unknown keys', () => {
    const lastMonth = resolvePeriod('last_month', NOW);
    assert.equal(lastMonth.start.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(lastMonth.end.toISOString(), '2026-11-01T00:00:00.000Z');
    assert.equal(lastMonth.days, 31);
    assert.equal(resolvePeriod('nonsense', NOW).key, '7d');
});

test('countWorkingDays skips weekends', () => {
    assert.equal(countWorkingDays(new Date('2026-10-31T00:00:00Z'), new Date('2026-11-02T00:00:00Z')), 0);
    assert.equal(countWorkingDays(new Date('2026-10-26T00:00:00Z'), new Date('2026-11-09T00:00:00Z')), 10);
});

test('proratedCostLines prorates by overlap and honours inclusive end dates', () => {
    const start = new Date('2026-10-01T00:00:00Z');
    const end = new Date('2026-11-01T00:00:00Z');
    const lines = proratedCostLines([
        { id: 1, label: 'Inboxes', category: 'inboxes', monthly_amount: '1000', starts_on: '2026-01-01', ends_on: null },
        { id: 2, label: 'Domains', category: 'domains', monthly_amount: 300, starts_on: '2026-10-16', ends_on: null },
        { id: 3, label: 'Old tool', category: 'tools', monthly_amount: 500, starts_on: '2026-01-01', ends_on: '2026-09-30' },
        { id: 4, label: 'One day', category: 'tools', monthly_amount: DAYS_PER_MONTH, starts_on: '2026-10-01', ends_on: '2026-10-01' }
    ], start, end);
    assert.deepEqual(lines.map((l) => [l.id, l.amount]), [
        [1, Math.round(1000 * 31 / DAYS_PER_MONTH * 100) / 100],
        [2, Math.round(300 * 16 / DAYS_PER_MONTH * 100) / 100],
        [4, 1]
    ]);
});

function call(overrides) {
    return {
        id: overrides.id ?? 1,
        company: 'shop.com',
        booked_at: null,
        call_at: null,
        call_status: 'booked',
        qualified: null,
        proposal_sent_on: null,
        outcome: 'open',
        closed_on: null,
        lost_reason: null,
        build_value: null,
        retainer_monthly: null,
        retainer_start: null,
        retainer_end: null,
        last_contact_on: null,
        next_follow_up_on: null,
        ...overrides
    };
}

test('computeSalesMetrics: funnel ratios inside the period', () => {
    const { start, end } = resolvePeriod('7d', NOW);
    const calls = [
        call({ id: 1, booked_at: '2026-10-27T10:00:00Z', call_at: '2026-10-28T15:00:00Z', call_status: 'held', qualified: true, proposal_sent_on: '2026-10-29', outcome: 'won', closed_on: '2026-10-31', build_value: 3000, retainer_monthly: 2000, retainer_start: '2026-10-31' }),
        call({ id: 2, booked_at: '2026-10-27T11:00:00Z', call_at: '2026-10-29T15:00:00Z', call_status: 'held', qualified: false, proposal_sent_on: '2026-10-30', outcome: 'lost', closed_on: '2026-11-01', lost_reason: 'price' }),
        call({ id: 3, booked_at: '2026-10-28T11:00:00Z', call_at: '2026-10-30T15:00:00Z', call_status: 'no_show' }),
        call({ id: 4, booked_at: '2026-10-28T12:00:00Z', call_at: '2026-10-31T15:00:00Z', call_status: 'booked' }),
        call({ id: 5, booked_at: '2026-10-29T12:00:00Z', call_at: '2026-11-04T15:00:00Z', call_status: 'canceled' }),
        // booked before the period, call later than now: not due
        call({ id: 6, booked_at: '2026-10-20T12:00:00Z', call_at: '2026-11-05T15:00:00Z' }),
        // same person as call 1 rebooking: counted once
        call({ id: 7, contact_id: '11', booked_at: '2026-10-28T09:00:00Z', call_status: 'canceled' })
    ].map((c) => (c.id === 1 ? { ...c, contact_id: '11' } : c));
    const { sales, money } = computeSalesMetrics(calls, {
        start, end, now: NOW, positives: 20, outreachCost: 4000,
        // '11' is already in the log; '99' booked via Instantly only
        bookedContactIds: ['11', '99']
    });
    // people 1(=7), 2, 3, 4, 5 (canceled, still counts) + Instantly-only 99
    assert.equal(sales.callsBooked, 6);
    assert.equal(sales.callsCanceled, 1);
    assert.equal(sales.bookingRate, 6 / 20);
    // calls 1 and 2 marked held, call 4 past and not canceled: assumed held
    assert.equal(sales.callsHeld, 3);
    assert.equal(sales.noShows, 1);
    assert.equal(sales.callsAssumedHeld, 1);
    // held ÷ (held + no-shows + people who canceled)
    assert.equal(sales.showRate, 3 / 5);
    assert.equal(sales.qualifiedRate, 1 / 3);
    assert.equal(sales.proposalRate, 2 / 3);
    assert.equal(sales.closeRate, 1 / 2);
    assert.equal(sales.overallCloseRate, 1 / 3);
    assert.equal(sales.avgDaysToClose, 3);
    assert.deepEqual(sales.lostReasons, { price: 1 });

    assert.equal(money.buildRevenue, 3000);
    assert.equal(money.retainerRevenue, 2000);
    assert.equal(money.newRevenue, 5000);
    assert.equal(money.avgDealValue, 5000);
    assert.equal(money.costPerBookedCall, Math.round(4000 / 6 * 100) / 100);
    assert.equal(money.costPerProposal, 2000);
    assert.equal(money.roas, 1.25);
    assert.equal(money.costPerClient, 4000);
    assert.equal(money.paybackMonths, 2);
    assert.equal(money.activeRetainers, 1);
    assert.equal(money.mrr, 2000);
});

test('computeSalesMetrics: Calendly-only data assumes held and leaves untracked steps null', () => {
    const { start, end } = resolvePeriod('7d', NOW);
    const calls = [
        call({ id: 1, booked_at: '2026-10-27T10:00:00Z', call_at: '2026-10-28T15:00:00Z' }),
        call({ id: 2, booked_at: '2026-10-27T11:00:00Z', call_at: '2026-10-29T15:00:00Z', call_status: 'no_show' }),
        call({ id: 3, booked_at: '2026-10-28T11:00:00Z', call_at: '2026-11-04T15:00:00Z' })
    ];
    const { sales } = computeSalesMetrics(calls, { start, end, now: NOW, positives: 10 });
    assert.equal(sales.callsHeld, 1);
    assert.equal(sales.showRate, 1 / 2);
    assert.equal(sales.qualifiedRate, null);
    assert.equal(sales.proposalRate, null);
    assert.equal(sales.closeRate, null);
    assert.equal(sales.overallCloseRate, null);
});

test('computeSalesMetrics: stalled deals respect scheduled follow-ups', () => {
    const { start, end } = resolvePeriod('7d', NOW);
    const calls = [
        call({ id: 1, company: 'quiet.com', call_at: '2026-10-20T15:00:00Z', call_status: 'held' }),
        call({ id: 2, company: 'scheduled.com', call_at: '2026-10-20T15:00:00Z', call_status: 'held', next_follow_up_on: '2026-11-05' }),
        call({ id: 3, company: 'recent.com', call_at: '2026-10-20T15:00:00Z', call_status: 'held', last_contact_on: '2026-10-31' }),
        call({ id: 4, company: 'closed.com', call_at: '2026-10-01T15:00:00Z', call_status: 'held', outcome: 'lost', closed_on: '2026-10-05' })
    ];
    const { sales } = computeSalesMetrics(calls, { start, end, now: NOW });
    assert.deepEqual(sales.stalledDeals.map((d) => d.name), ['quiet.com']);
    assert.equal(sales.stalledDeals[0].daysQuiet, 13);
    assert.equal(sales.bookingRate, null);
});

test('computeSalesMetrics: churn, tenure and lifetime value', () => {
    const { start, end } = resolvePeriod('last_month', NOW);
    const calls = [
        call({ id: 1, outcome: 'won', retainer_monthly: 2000, retainer_start: '2026-04-01', retainer_end: '2026-10-15' }),
        call({ id: 2, outcome: 'won', retainer_monthly: 1000, retainer_start: '2026-08-01' }),
        call({ id: 3, outcome: 'won', retainer_monthly: 1500, retainer_start: '2026-10-20' })
    ];
    const { money } = computeSalesMetrics(calls, { start, end, now: NOW });
    assert.equal(money.activeAtPeriodStart, 2);
    assert.equal(money.churnedInPeriod, 1);
    assert.ok(Math.abs(money.monthlyChurn - 0.5 * DAYS_PER_MONTH / 31) < 1e-9);
    assert.equal(money.activeRetainers, 2);
    assert.equal(money.mrr, 2500);
    assert.equal(money.avgRetainer, 1500);
    // Tenures to today (2026-11-02) or end: 197, 93 and 13 days.
    const avgMonths = (197 + 93 + 13) / 3 / DAYS_PER_MONTH;
    assert.equal(money.avgTenureMonths, Math.round(avgMonths * 10) / 10);
    assert.equal(money.lifetimeValue, Math.round(avgMonths * 1500 * 100) / 100);
});

test('buildScriptRows joins Instantly totals, positives and runway', () => {
    const { scripts, unattributedPositives } = buildScriptRows({
        instantlyRows: [
            { campaign_id: 'abc', campaign_name: 'BFCM', campaign_status: 1, emails_sent_count: 30000, new_leads_contacted_count: 10000, bounced_count: 500 },
            { campaign_id: 'old', campaign_name: 'Old', campaign_status: 2, emails_sent_count: 0, new_leads_contacted_count: 0, bounced_count: 0 }
        ],
        campaigns: [
            { id: 10, instantly_campaign_id: 'abc', name: 'BFCM', status: 1, start_date: '2026-10-20T00:00:00Z' },
            { id: 11, instantly_campaign_id: 'old', name: 'Old', status: 2, start_date: '2026-01-01T00:00:00Z' }
        ],
        positivesRows: [{ campaign_id: 10, positives: 30 }, { campaign_id: null, positives: 2 }],
        runwayCampaigns: [{ id: 'abc', runwayDays: 2.5, runsDryOn: '2026-11-05' }],
        now: NOW
    });
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].daysLive, 13);
    assert.equal(scripts[0].positiveRate, 0.003);
    assert.equal(scripts[0].runwayDays, 2.5);
    assert.equal(unattributedPositives, 2);
});

test('normalizeSalesCall closes, clears lost reason and starts retainers', () => {
    const won = normalizeSalesCall({ outcome: 'won', lost_reason: 'price', retainer_monthly: 1000 });
    assert.ok(won.closed_on);
    assert.equal(won.lost_reason, null);
    assert.equal(won.retainer_start, won.closed_on);
    const reopened = normalizeSalesCall({ outcome: 'open', closed_on: '2026-10-01', lost_reason: 'price' });
    assert.equal(reopened.closed_on, null);
    assert.equal(reopened.lost_reason, null);
    assert.throws(() => normalizeSalesCall({ outcome: 'open', retainer_start: '2026-10-02', retainer_end: '2026-10-01' }));
});

test('computeSalesMetrics: lists the people behind each sales card', () => {
    const { start, end } = resolvePeriod('7d', NOW);
    const calls = [
        call({ id: 1, contact_id: '11', company: 'won.com', booked_at: '2026-10-27T10:00:00Z', call_at: '2026-10-28T15:00:00Z', call_status: 'held', qualified: true, proposal_sent_on: '2026-10-29', outcome: 'won', closed_on: '2026-10-31' }),
        call({ id: 2, contact_id: '11', company: 'won.com', booked_at: '2026-10-28T10:00:00Z', call_status: 'canceled' }),
        call({ id: 3, company: 'ghost.com', booked_at: '2026-10-29T10:00:00Z', call_status: 'canceled' }),
        call({ id: 4, company: 'past.com', booked_at: '2026-10-29T11:00:00Z', call_at: '2026-10-30T15:00:00Z' })
    ];
    const { sales } = computeSalesMetrics(calls, {
        start, end, now: NOW, positives: 10,
        bookedContactIds: [{ contact_id: '11' }, { contact_id: '77', name: 'Ivy', company: 'instantly.com', booked_at: '2026-10-30T09:00:00Z' }]
    });
    const { lists } = sales;
    assert.equal(lists.callsBooked.length, sales.callsBooked);
    assert.deepEqual(lists.callsBooked.map((e) => `${e.company}:${e.detail}`).sort(), [
        'ghost.com:Canceled', 'instantly.com:Marked "meeting booked" in Instantly', 'past.com:Booked', 'won.com:Held'
    ]);
    assert.deepEqual(lists.showRate.map((e) => `${e.company}:${e.detail}`).sort(), [
        'past.com:Held (assumed)', 'won.com:Held'
    ]);
    assert.deepEqual(lists.qualified.map((e) => e.detail).sort(), ['Good fit', 'Not decided']);
    assert.deepEqual(lists.closes.map((e) => e.detail), ['Won']);
});

test('computeSalesMetrics: a person with two held calls counts once', () => {
    const { start, end } = resolvePeriod('30d', NOW);
    const calls = [
        call({ id: 1, contact_id: '5', company: 'tara.com', booked_at: '2026-10-04T10:00:00Z', call_at: '2026-10-05T19:00:00Z', call_status: 'held', qualified: true }),
        call({ id: 2, contact_id: '5', company: 'tara.com', booked_at: '2026-10-10T10:00:00Z', call_at: '2026-10-14T18:00:00Z', call_status: 'held', qualified: null }),
        call({ id: 3, contact_id: '6', company: 'other.com', booked_at: '2026-10-10T10:00:00Z', call_at: '2026-10-15T18:00:00Z', call_status: 'held', qualified: false })
    ];
    const { sales } = computeSalesMetrics(calls, { start, end, now: NOW, positives: 10 });
    assert.equal(sales.callsBooked, 2);
    assert.equal(sales.callsHeld, 2);
    assert.equal(sales.qualifiedRate, 1 / 2);
    assert.deepEqual(sales.lists.qualified.map((e) => `${e.company}:${e.detail}`).sort(), ['other.com:Not a fit', 'tara.com:Good fit']);
    assert.equal(sales.lists.showRate.length, 2);
});
