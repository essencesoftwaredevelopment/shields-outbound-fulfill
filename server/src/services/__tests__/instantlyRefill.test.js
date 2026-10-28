import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRefillLead, needsReverify, pickLeadsToAdd, planRefill } from '../instantlyRefill.js';

const now = new Date('2026-10-28T12:00:00Z');
const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('planRefill', () => {
    it('tops the backlog up to backlog days × new leads/day', () => {
        assert.deepEqual(planRefill({ newLeadsPerDay: 2400, backlogDays: 2, backlog: 160 }), { target: 4800, shortfall: 4640, need: 4640 });
    });

    it('waits on small shortfalls and never goes negative', () => {
        assert.equal(planRefill({ newLeadsPerDay: 2400, backlogDays: 2, backlog: 4780 }).need, 0);
        assert.equal(planRefill({ newLeadsPerDay: 2400, backlogDays: 2, backlog: 9000 }).shortfall, 0);
    });

    it('caps one run', () => {
        assert.equal(planRefill({ newLeadsPerDay: 5000, backlogDays: 5, backlog: 0 }).need, 6000);
    });
});

describe('needsReverify', () => {
    it('re-checks missing or older-than-90-day verdicts only', () => {
        assert.equal(needsReverify(null, now), true);
        assert.equal(needsReverify(daysAgo(91), now), true);
        assert.equal(needsReverify(daysAgo(30), now), false);
    });
});

describe('pickLeadsToAdd', () => {
    it('keeps order, trusts fresh verdicts, and needs a valid re-check for stale ones', () => {
        const candidates = [
            { contact_id: 1, email: 'Stale-Valid@x.com', email_verify_completed_at: daysAgo(200) },
            { contact_id: 2, email: 'stale-invalid@x.com', email_verify_completed_at: daysAgo(200) },
            { contact_id: 3, email: 'unchecked@x.com', email_verify_completed_at: null },
            { contact_id: 4, email: 'fresh@x.com', email_verify_completed_at: daysAgo(10) },
            { contact_id: 5, email: 'extra@x.com', email_verify_completed_at: daysAgo(10) }
        ];
        const verdicts = new Map([['stale-valid@x.com', 'valid'], ['stale-invalid@x.com', 'invalid']]);
        assert.deepEqual(pickLeadsToAdd(candidates, verdicts, 2, now).map((r) => r.contact_id), [1, 4]);
        assert.deepEqual(pickLeadsToAdd(candidates, verdicts, 10, now).map((r) => r.contact_id), [1, 4, 5]);
    });
});

describe('buildRefillLead', () => {
    it('matches the pipeline auto-add fields', () => {
        assert.deepEqual(
            buildRefillLead({ email: 'a@shop.com', full_name: 'Mary Ann Lee', domain: 'shop.com', personalization_first_line: 'Love the drops.' }),
            { email: 'a@shop.com', first_name: 'Mary', last_name: 'Ann Lee', website: 'shop.com', personalization: 'Love the drops.' }
        );
    });
});
