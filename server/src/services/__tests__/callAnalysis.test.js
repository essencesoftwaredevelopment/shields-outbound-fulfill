import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyFathomSignature } from '../fathom.js';
import { formatTranscript, normalizeAnalysis, planSalesCallUpdate } from '../callAnalysis/extract.js';
import { businessDomains, externalEmails, parseDomainList } from '../callAnalysis/index.js';

const SECRET = `whsec_${Buffer.from('fathom-test-secret').toString('base64')}`;

function sign(id, timestamp, body) {
    const key = Buffer.from(SECRET.slice('whsec_'.length), 'base64');
    return crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

test('verifyFathomSignature accepts a valid v1 signature among several', () => {
    const body = JSON.stringify({ recording_id: 1 });
    const ts = 1_800_000_000;
    const headers = {
        'webhook-id': 'msg_1',
        'webhook-timestamp': String(ts),
        'webhook-signature': `v1,bogus v1,${sign('msg_1', ts, body)}`
    };
    assert.deepEqual(verifyFathomSignature({ rawBody: Buffer.from(body), headers, secret: SECRET, nowSeconds: ts + 10 }), { valid: true });
});

test('verifyFathomSignature rejects tampering, stale timestamps and missing secrets', () => {
    const body = JSON.stringify({ recording_id: 1 });
    const ts = 1_800_000_000;
    const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sign('msg_1', ts, body)}` };
    assert.equal(verifyFathomSignature({ rawBody: `${body} `, headers, secret: SECRET, nowSeconds: ts }).reason, 'signature_mismatch');
    assert.equal(verifyFathomSignature({ rawBody: body, headers, secret: SECRET, nowSeconds: ts + 3600 }).reason, 'timestamp_out_of_tolerance');
    assert.equal(verifyFathomSignature({ rawBody: body, headers, secret: '', nowSeconds: ts }).reason, 'no_secret');
});

test('externalEmails and businessDomains', () => {
    const emails = externalEmails([
        { email: 'Meg@MoreCatsPlease.com', is_external: true },
        { email: 'jacques@essenceretention.com', is_external: false },
        { email: 'hawkenfishing@gmail.com', is_external: true },
        { name: 'No email', is_external: true }
    ]);
    assert.deepEqual(emails, ['meg@morecatsplease.com', 'hawkenfishing@gmail.com']);
    assert.deepEqual(businessDomains(emails), ['morecatsplease.com']);
});

test('formatTranscript labels prospect and ESSENCE speakers', () => {
    const text = formatTranscript(
        [
            { speaker: { display_name: 'Jacques', matched_calendar_invitee_email: 'jacques@essenceretention.com' }, text: 'Hi', timestamp: '00:00:01' },
            { speaker: { display_name: 'Meg', matched_calendar_invitee_email: 'meg@morecatsplease.com' }, text: 'Hello', timestamp: '00:00:03' }
        ],
        [{ email: 'meg@morecatsplease.com', is_external: true }]
    );
    assert.equal(text, '[00:00:01] Jacques (ESSENCE): Hi\n[00:00:03] Meg (prospect): Hello');
});

test('normalizeAnalysis drops invalid values', () => {
    const a = normalizeAnalysis({
        is_sales_conversation: true, deal_status: 'open', lost_reason: 'price', build_price: -5,
        retainer_monthly_price: 1999.999, next_follow_up_date: 'next tuesday', proposal_status: 'maybe'
    });
    assert.equal(a.lost_reason, null);
    assert.equal(a.build_price, null);
    assert.equal(a.retainer_monthly_price, 2000);
    assert.equal(a.next_follow_up_date, null);
    assert.equal(a.proposal_status, 'none');
});

const baseCall = {
    call_status: 'booked', call_at: '2026-10-29T20:30:00Z', qualified: null, proposal_sent_on: null,
    outcome: 'open', closed_on: null, lost_reason: null, build_value: null, retainer_monthly: null,
    retainer_start: null, last_contact_on: null, next_follow_up_on: null,
    ai_filled_fields: [], ai_source_recorded_at: null
};

const discovery = normalizeAnalysis({
    is_sales_conversation: true, call_type: 'discovery', summary: 'Good call', good_fit: true,
    build_price: 4000, retainer_monthly_price: 2000, proposal_status: 'promised', deal_status: 'open',
    next_follow_up_date: '2026-11-05'
});

test('planSalesCallUpdate fills a fresh booked call from a discovery call', () => {
    const { changes, filledFields } = planSalesCallUpdate(baseCall, discovery, { recorded_at: '2026-10-29T20:31:00Z' });
    assert.deepEqual(changes, {
        call_status: 'held',
        last_contact_on: '2026-10-29',
        qualified: true,
        build_value: 4000,
        retainer_monthly: 2000,
        next_follow_up_on: '2026-11-05'
    });
    assert.ok(filledFields.includes('qualified'));
    assert.ok(!('proposal_sent_on' in changes), 'a promised proposal is not a sent one');
});

test('planSalesCallUpdate never overwrites a manual edit, but updates its own fields', () => {
    const call = {
        ...baseCall, call_status: 'held', qualified: false, retainer_monthly: 1500,
        ai_filled_fields: ['retainer_monthly', 'call_status'], ai_source_recorded_at: '2026-10-29T20:31:00Z'
    };
    const closing = normalizeAnalysis({
        is_sales_conversation: true, call_type: 'closing', summary: 'Agreed', good_fit: true,
        retainer_monthly_price: 600, proposal_status: 'sent', deal_status: 'won'
    });
    const { changes } = planSalesCallUpdate(call, closing, { recorded_at: '2026-11-02T15:00:00Z' });
    assert.ok(!('qualified' in changes), 'qualified=false was set by hand');
    assert.equal(changes.retainer_monthly, 600);
    assert.equal(changes.outcome, 'won');
    assert.equal(changes.closed_on, '2026-11-02');
    assert.equal(changes.proposal_sent_on, '2026-11-02');
    assert.equal(changes.retainer_start, '2026-11-02');
});

test('planSalesCallUpdate: an older recording only fills empty fields', () => {
    const call = {
        ...baseCall, call_status: 'held', retainer_monthly: 600, outcome: 'won', closed_on: '2026-11-02',
        ai_filled_fields: ['retainer_monthly', 'outcome', 'closed_on'], ai_source_recorded_at: '2026-11-02T15:00:00Z'
    };
    const { changes } = planSalesCallUpdate(call, discovery, { recorded_at: '2026-10-29T20:31:00Z' });
    assert.ok(!('retainer_monthly' in changes));
    assert.ok(!('outcome' in changes));
    assert.equal(changes.qualified, true);
    assert.equal(changes.build_value, 4000);
});

test('planSalesCallUpdate: non-sales recordings only mark the call held', () => {
    const delivery = normalizeAnalysis({ is_sales_conversation: false, call_type: 'onboarding_or_delivery', good_fit: true, retainer_monthly_price: 999 });
    const { changes } = planSalesCallUpdate(baseCall, delivery, { recorded_at: '2026-11-01T10:00:00Z' });
    assert.deepEqual(changes, { call_status: 'held', last_contact_on: '2026-11-01' });
});

test('parseDomainList accepts commas, spaces, @ and URLs', () => {
    assert.deepEqual(
        parseDomainList(' essenceretention.com, @Other.io  https://third.co/path '),
        ['essenceretention.com', 'other.io', 'third.co']
    );
    assert.deepEqual(parseDomainList(undefined), []);
});
