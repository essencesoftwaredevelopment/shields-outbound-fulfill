/**
 * warmFollowUpStatus.test.js
 *
 * Unit tests for the post-autoresponder Instantly status update.
 * Uses Node's built-in test runner (node:test / node:assert/strict).
 *
 * Run:
 *   node --test src/services/__tests__/warmFollowUpStatus.test.js
 *
 * All tests use injected fakes — no live DB or Instantly connection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeLeadLabels,
    resolveWarmFollowUpStatusConfig,
    applyWarmFollowUpStatusAfterAutoresponderSend,
    WARM_FOLLOW_UP_LABEL_SKIPPED_EVENT,
    WARM_FOLLOW_UP_LABEL_FAILED_EVENT
} from '../warmFollowUpStatus.js';

// ─── normalizeLeadLabels ─────────────────────────────────────────────────────

test('normalizeLeadLabels maps Instantly v2 lead-label objects to picker options', () => {
    const result = normalizeLeadLabels([
        {
            id: '0198f690-38b9-7176-810f-29ba8c4d4011',
            label: 'Warm Follow Up',
            interest_status_label: 'positive',
            interest_status: 51,
            description: 'When they have seen the loom'
        },
        {
            id: '0199864c-6203-79d0-b94a-1b983babdb58',
            label: 'Bad Fit',
            interest_status_label: 'negative',
            interest_status: -499,
            description: ''
        }
    ]);
    assert.deepEqual(result, [
        { value: 51, label: 'Warm Follow Up', sentiment: 'positive', description: 'When they have seen the loom' },
        { value: -499, label: 'Bad Fit', sentiment: 'negative', description: '' }
    ]);
});

test('normalizeLeadLabels skips invalid rows and dedupes by value', () => {
    const result = normalizeLeadLabels([
        { label: 'Day 1', interest_status: 52 },
        { label: '', interest_status: 53 },
        { label: 'No value' },
        { label: 'Bad value', interest_status: 'nope' },
        { label: 'Day 1 duplicate', interest_status: 52 },
        null,
        undefined
    ]);
    assert.deepEqual(result.map((item) => item.value), [52]);
    assert.equal(result[0].label, 'Day 1');
});

test('normalizeLeadLabels returns empty array for non-array input', () => {
    assert.deepEqual(normalizeLeadLabels(null), []);
    assert.deepEqual(normalizeLeadLabels(undefined), []);
    assert.deepEqual(normalizeLeadLabels({}), []);
});

// ─── resolveWarmFollowUpStatusConfig ─────────────────────────────────────────

test('resolveWarmFollowUpStatusConfig reads configured value and label', () => {
    const config = resolveWarmFollowUpStatusConfig({
        warm_follow_up_interest_value: 51,
        warm_follow_up_interest_label: 'Warm Follow Up'
    });
    assert.deepEqual(config, { interestValue: 51, label: 'Warm Follow Up' });
});

test('resolveWarmFollowUpStatusConfig returns null when unset or invalid', () => {
    assert.equal(resolveWarmFollowUpStatusConfig(null), null);
    assert.equal(resolveWarmFollowUpStatusConfig({}), null);
    assert.equal(resolveWarmFollowUpStatusConfig({ warm_follow_up_interest_value: null }), null);
    assert.equal(resolveWarmFollowUpStatusConfig({ warm_follow_up_interest_value: 'abc' }), null);
});

test('resolveWarmFollowUpStatusConfig tolerates numeric strings from pg', () => {
    const config = resolveWarmFollowUpStatusConfig({ warm_follow_up_interest_value: '51' });
    assert.deepEqual(config, { interestValue: 51, label: null });
});

// ─── applyWarmFollowUpStatusAfterAutoresponderSend ───────────────────────────

const BASE_ARGS = {
    draftId: 401,
    agencyId: 'agency-1',
    clientId: 2,
    contactId: 1719683,
    campaignId: 134,
    instantlyCampaignId: '944cde15-7379-4a46-a16d-2f9d5fb445d9',
    instantlyLeadId: null,
    leadEmail: 'lead@example.com',
    apiKey: 'test-key'
};

function makeFakeDb() {
    const calls = [];
    return {
        calls,
        query: async (sql, params) => {
            calls.push({ sql, params });
            return { rows: [] };
        }
    };
}

function makeFakeUpdateFn(behavior = async () => ({})) {
    const calls = [];
    const fn = async (apiKey, params) => {
        calls.push({ apiKey, params });
        return behavior(apiKey, params);
    };
    fn.calls = calls;
    return fn;
}

test('apply: no configured status → skip marker, no API call', async () => {
    const db = makeFakeDb();
    const updateFn = makeFakeUpdateFn();

    const result = await applyWarmFollowUpStatusAfterAutoresponderSend(
        { ...BASE_ARGS, statusConfig: null },
        { db, updateFn }
    );

    assert.deepEqual(result, { applied: false, reason: 'not_configured' });
    assert.equal(updateFn.calls.length, 0);
    assert.equal(db.calls.length, 1);
    assert.ok(db.calls[0].params.includes(WARM_FOLLOW_UP_LABEL_SKIPPED_EVENT));
    const payload = JSON.parse(db.calls[0].params[12]);
    assert.equal(payload.reason, 'not_configured');
    assert.equal(payload.interested_autoresponder_draft_id, 401);
});

test('apply: missing campaign id → skip marker with reason', async () => {
    const db = makeFakeDb();
    const updateFn = makeFakeUpdateFn();

    const result = await applyWarmFollowUpStatusAfterAutoresponderSend(
        {
            ...BASE_ARGS,
            instantlyCampaignId: null,
            statusConfig: { interestValue: 51, label: 'Warm Follow Up' }
        },
        { db, updateFn }
    );

    assert.deepEqual(result, { applied: false, reason: 'missing_campaign_id' });
    assert.equal(updateFn.calls.length, 0);
    const payload = JSON.parse(db.calls[0].params[12]);
    assert.equal(payload.event_type, WARM_FOLLOW_UP_LABEL_SKIPPED_EVENT);
    assert.equal(payload.reason, 'missing_campaign_id');
});

test('apply: success → API called with configured value, no marker written', async () => {
    const db = makeFakeDb();
    const updateFn = makeFakeUpdateFn();

    const result = await applyWarmFollowUpStatusAfterAutoresponderSend(
        { ...BASE_ARGS, statusConfig: { interestValue: 51, label: 'Warm Follow Up' } },
        { db, updateFn }
    );

    assert.deepEqual(result, { applied: true });
    assert.equal(updateFn.calls.length, 1);
    assert.equal(updateFn.calls[0].apiKey, 'test-key');
    assert.deepEqual(updateFn.calls[0].params, {
        campaignId: '944cde15-7379-4a46-a16d-2f9d5fb445d9',
        leadEmail: 'lead@example.com',
        interestValue: 51
    });
    assert.equal(db.calls.length, 0);
});

test('apply: API failure → failed marker with error message, does not throw', async () => {
    const db = makeFakeDb();
    const updateFn = makeFakeUpdateFn(async () => {
        throw new Error('Instantly API POST /api/v2/leads/update-interest-status failed (404): label missing');
    });

    const result = await applyWarmFollowUpStatusAfterAutoresponderSend(
        { ...BASE_ARGS, statusConfig: { interestValue: 51, label: 'Warm Follow Up' } },
        { db, updateFn }
    );

    assert.equal(result.applied, false);
    assert.equal(result.reason, 'api_error');
    assert.equal(db.calls.length, 1);
    assert.ok(db.calls[0].params.includes(WARM_FOLLOW_UP_LABEL_FAILED_EVENT));
    const payload = JSON.parse(db.calls[0].params[12]);
    assert.equal(payload.event_type, WARM_FOLLOW_UP_LABEL_FAILED_EVENT);
    assert.equal(payload.reason, 'api_error');
    assert.match(payload.error_message, /404/);
    assert.equal(payload.interest_value, 51);
});

test('apply: marker insert failure is swallowed', async () => {
    const db = {
        query: async () => {
            throw new Error('db down');
        }
    };
    const updateFn = makeFakeUpdateFn(async () => {
        throw new Error('boom');
    });

    const result = await applyWarmFollowUpStatusAfterAutoresponderSend(
        { ...BASE_ARGS, statusConfig: { interestValue: 51, label: 'Warm Follow Up' } },
        { db, updateFn }
    );
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'api_error');
});
