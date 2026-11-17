import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    dedupeInterestedLeads,
    emailPlainText,
    groupInboundByLead,
    interestedLeadIdentity,
    isInboundReply,
    isInstantlyPollReconcileEnabled,
    nextEmailCursor,
    pickLatestInbound,
    pollReconcileIntervalMs,
    shouldDraftNewInterest
} from '../instantlyPollReconcile.js';

const SEEDED = '2026-11-17T00:00:00.000Z';

describe('shouldDraftNewInterest', () => {
    it('records the baseline without drafting', () => {
        assert.equal(shouldDraftNewInterest({
            previousInterestStatus: null,
            interestChangedAt: '2026-11-17T01:00:00.000Z',
            seededAt: null,
            seeding: true
        }), false);
    });

    it('drafts a flip to interested after the baseline', () => {
        assert.equal(shouldDraftNewInterest({
            previousInterestStatus: null,
            interestChangedAt: '2026-11-17T00:05:00.000Z',
            seededAt: SEEDED,
            seeding: false
        }), true);
        assert.equal(shouldDraftNewInterest({
            previousInterestStatus: -1,
            interestChangedAt: '2026-11-17T00:05:00.000Z',
            seededAt: SEEDED,
            seeding: false
        }), true);
    });

    it('leaves leads who were already interested, including ones labeled before the baseline', () => {
        assert.equal(shouldDraftNewInterest({
            previousInterestStatus: 1,
            interestChangedAt: '2026-11-17T02:00:00.000Z',
            seededAt: SEEDED,
            seeding: false
        }), false);
        assert.equal(shouldDraftNewInterest({
            previousInterestStatus: '1',
            interestChangedAt: '2026-11-17T02:00:00.000Z',
            seededAt: SEEDED,
            seeding: false
        }), false);
        assert.equal(shouldDraftNewInterest({
            previousInterestStatus: null,
            interestChangedAt: '2026-11-16T12:00:00.000Z',
            seededAt: SEEDED,
            seeding: false
        }), false);
    });

    it('drafts when Instantly omits the interest timestamp after the baseline exists', () => {
        assert.equal(shouldDraftNewInterest({
            previousInterestStatus: null,
            interestChangedAt: null,
            seededAt: SEEDED,
            seeding: false
        }), true);
    });
});

describe('interested lead identity', () => {
    it('keeps one row per campaign and email, preferring the latest interest change', () => {
        const rows = dedupeInterestedLeads([
            { id: 'a', email: 'Pat@Example.com', campaign: 'camp-1', timestamp_last_interest_change: '2026-11-01T00:00:00.000Z' },
            { id: 'b', email: 'pat@example.com', campaign: 'camp-1', timestamp_last_interest_change: '2026-11-02T00:00:00.000Z' },
            { id: 'c', email: 'pat@example.com', campaign: 'camp-2' },
            { id: 'd', email: 'no-campaign@example.com' }
        ]);
        assert.equal(rows.length, 2);
        const first = rows.find((row) => row.campaignId === 'camp-1');
        assert.equal(first.instantlyLeadId, 'b');
        assert.equal(first.email, 'pat@example.com');
        assert.equal(interestedLeadIdentity({ email: '', campaign: 'x' }), null);
    });
});

describe('inbound replies', () => {
    it('keeps received mail and drops sends, manual replies, and auto-replies', () => {
        assert.equal(isInboundReply({ id: '1', ue_type: 2 }), true);
        assert.equal(isInboundReply({ id: '1' }), true);
        assert.equal(isInboundReply({ id: '1', ue_type: 1 }), false);
        assert.equal(isInboundReply({ id: '1', ue_type: 3 }), false);
        assert.equal(isInboundReply({ id: '1', ue_type: 2, is_auto_reply: 1 }), false);
        assert.equal(isInboundReply({ ue_type: 2 }), false);
    });

    it('picks the latest inbound with a sending account and groups by campaign', () => {
        const emails = [
            { id: 'old', ue_type: 2, eaccount: 'from@co.com', lead: 'a@x.com', campaign_id: 'c1', timestamp_email: '2026-11-17T00:00:00.000Z' },
            { id: 'new', ue_type: 2, eaccount: 'from@co.com', lead: 'A@x.com', campaign_id: 'c1', timestamp_email: '2026-11-17T03:00:00.000Z', body: { text: 'Sounds good' } },
            { id: 'send', ue_type: 1, eaccount: 'from@co.com', lead: 'a@x.com', campaign_id: 'c1', timestamp_email: '2026-11-17T04:00:00.000Z' }
        ];
        assert.equal(pickLatestInbound(emails).id, 'new');
        const grouped = groupInboundByLead(emails);
        assert.equal(grouped.size, 1);
        assert.equal(grouped.get('c1::a@x.com').length, 2);
        assert.equal(emailPlainText({ body: { html: 'Hello<br>there' } }), 'Hello\nthere');
    });
});

describe('nextEmailCursor', () => {
    const now = Date.parse('2026-11-17T12:00:00.000Z');

    it('moves to just before now when the inbox page is complete', () => {
        assert.equal(nextEmailCursor({
            previousCursor: '2026-11-17T10:00:00.000Z',
            emails: [{ timestamp_created: '2026-11-17T11:00:00.000Z' }],
            hitPageCap: false,
            now
        }), '2026-11-17T11:58:00.000Z');
    });

    it('stops at the newest email when more pages remain', () => {
        assert.equal(nextEmailCursor({
            previousCursor: '2026-11-17T10:00:00.000Z',
            emails: [
                { timestamp_created: '2026-11-17T10:30:00.000Z' },
                { timestamp_created: '2026-11-17T10:45:00.000Z' }
            ],
            hitPageCap: true,
            now
        }), '2026-11-17T10:44:59.000Z');
    });
});

describe('isInstantlyPollReconcileEnabled', () => {
    it('only polls from production unless overridden', () => {
        assert.equal(isInstantlyPollReconcileEnabled({ NODE_ENV: 'production' }), true);
        assert.equal(isInstantlyPollReconcileEnabled({ NODE_ENV: 'development' }), false);
        assert.equal(isInstantlyPollReconcileEnabled({ NODE_ENV: 'production', INSTANTLY_POLL_RECONCILE_ENABLED: 'false' }), false);
        assert.equal(isInstantlyPollReconcileEnabled({ NODE_ENV: 'development', INSTANTLY_POLL_RECONCILE_ENABLED: 'true' }), true);
    });

    it('defaults to 10 minutes and refuses anything under a minute', () => {
        assert.equal(pollReconcileIntervalMs({}), 600000);
        assert.equal(pollReconcileIntervalMs({ INSTANTLY_POLL_RECONCILE_INTERVAL_MS: '300000' }), 300000);
        assert.equal(pollReconcileIntervalMs({ INSTANTLY_POLL_RECONCILE_INTERVAL_MS: '1000' }), 60000);
    });
});
