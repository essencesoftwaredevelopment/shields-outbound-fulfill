import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLeadListTableView, mapLeadListRow, leadListNeedsWarmFollowUpConfig } from '../leadListView.js';

const fullRow = {
    id: 42,
    domain_normalized: 'acme.test',
    email: 'ada@acme.test',
    full_name: 'Ada Lovelace',
    role_type: 'instantly:lead',
    email_status: 'valid',
    confidence: 0.9,
    email_find_completed_at: '2026-01-01T00:00:00.000Z',
    email_verify_completed_at: '2026-01-02T00:00:00.000Z',
    founder_find_completed_at: '2026-01-03T00:00:00.000Z',
    last_contacted_at: '2026-02-01T00:00:00.000Z',
    personalization_first_line: 'Loved the launch.',
    job_id: 'job-1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z',
    campaign_count_all_time: 3,
    campaign_count_active: 1,
    last_campaign_added_at: '2026-03-02T00:00:00.000Z',
    campaigns_data: [{
        campaignId: 'camp-1',
        campaignName: 'Q1 outbound',
        addedAt: '2026-03-02T00:00:00.000Z',
        active: true,
        lastReplyAt: '2026-03-04T00:00:00.000Z',
        lastReplyCategory: 'positive',
        leadStatus: 'active',
        interestStatus: 'interested',
        lastSyncedAt: '2026-03-05T00:00:00.000Z',
        lastBounceAt: null,
        timestampLastInterestChange: '2026-03-04T00:00:00.000Z'
    }],
    lists: [{ id: 7, name: 'VIP' }],
    latest_event_type: 'reply_received',
    latest_event_reply_category: 'positive',
    latest_event_message_text: 'Sure, happy to chat',
    latest_event_reply_text_snippet: 'Sure, happy',
    latest_event_timestamp: '2026-03-04T00:00:00.000Z',
    latest_event_email_account: 'sender@agency.test',
    annual_revenue_text: '1-10M',
    annual_revenue_min: 1000000,
    annual_revenue_max: 10000000,
    uses_klaviyo: true,
    klaviyo_percent: 12,
    discovery_call_held: false,
    last_discovery_call_at: null,
    insight_source: 'import',
    insight_notes: 'note',
    insight_attributes: { linkedin: 'https://linkedin.com/in/ada', instantly_id: 'xyz' }
};

describe('isLeadListTableView', () => {
    it('accepts view=table', () => {
        assert.equal(isLeadListTableView('table'), true);
        assert.equal(isLeadListTableView('TABLE'), true);
        assert.equal(isLeadListTableView('full'), false);
        assert.equal(isLeadListTableView(undefined), false);
    });
});

describe('leadListNeedsWarmFollowUpConfig', () => {
    it('skips the extra clients lookup unless Instantly status is filtered', () => {
        assert.equal(leadListNeedsWarmFollowUpConfig({}), false);
        assert.equal(leadListNeedsWarmFollowUpConfig({ instantlyStatus: 'interested' }), true);
        assert.equal(leadListNeedsWarmFollowUpConfig({
            filters: [{ field: 'email', op: 'eq', value: 'a@b.com' }]
        }), false);
        assert.equal(leadListNeedsWarmFollowUpConfig({
            filters: [{ field: 'instantly_status', op: 'eq', value: 'interested' }]
        }), true);
    });
});

describe('mapLeadListRow', () => {
    it('returns only the all-leads table fields for view=table', () => {
        const mapped = mapLeadListRow(fullRow, { tableView: true });
        assert.deepEqual(Object.keys(mapped).sort(), [
            'campaignsData',
            'domain',
            'email',
            'emailFindCompletedAt',
            'emailVerifyCompletedAt',
            'founderFindCompletedAt',
            'founderName',
            'id',
            'lists',
            'status',
            'verified'
        ]);
        assert.equal(mapped.verified, true);
        assert.deepEqual(mapped.campaignsData, [{
            campaignId: 'camp-1',
            campaignName: 'Q1 outbound',
            leadStatus: 'active',
            interestStatus: 'interested'
        }]);
        assert.equal(mapped.insights, undefined);
        assert.equal(mapped.firstLine, undefined);
        assert.equal(mapped.latestEvent, undefined);
    });

    it('keeps the full export/detail payload by default', () => {
        const mapped = mapLeadListRow(fullRow);
        assert.equal(mapped.roleType, 'instantly_lead');
        assert.equal(mapped.firstLine, 'Loved the launch.');
        assert.equal(mapped.insights.attributes.linkedin, 'https://linkedin.com/in/ada');
        assert.equal(mapped.campaignsData[0].lastReplyAt, '2026-03-04T00:00:00.000Z');
        assert.equal(mapped.latestEvent.eventType, 'reply_received');
    });
});
