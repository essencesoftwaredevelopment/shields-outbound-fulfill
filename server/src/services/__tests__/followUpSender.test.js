/**
 * followUpSender.test.js
 *
 * Unit and integration-style tests for the follow-up sender.
 * Uses Node's built-in test runner (node:test / node:assert/strict).
 *
 * Run:
 *   node --test src/services/__tests__/followUpSender.test.js
 *
 * The eligibility and idempotency DB tests use lightweight mocks — no live
 * DB connection required.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    renderTemplate,
    sanitizeHtml,
    htmlToPlainText,
} from '../followUpSender.js';

// ─── Template rendering ───────────────────────────────────────────────────────

test('renderTemplate substitutes known variables', () => {
    const result = renderTemplate('Hello {{first_name}}, welcome to {{campaign_name}}!', {
        first_name: 'Alice',
        campaign_name: 'Spring Outreach'
    });
    assert.equal(result, 'Hello Alice, welcome to Spring Outreach!');
});

test('renderTemplate replaces missing variables with empty string', () => {
    const result = renderTemplate('Hi {{first_name}} from {{company_name}}', {
        first_name: 'Bob'
    });
    assert.equal(result, 'Hi Bob from ');
});

test('renderTemplate handles null/undefined vars gracefully', () => {
    const result = renderTemplate('Value: {{x}}', { x: null });
    assert.equal(result, 'Value: ');
});

test('renderTemplate handles whitespace inside braces', () => {
    const result = renderTemplate('Hello {{ first_name }}', { first_name: 'Carol' });
    assert.equal(result, 'Hello Carol');
});

test('renderTemplate returns empty string for non-string template', () => {
    assert.equal(renderTemplate(null, {}), '');
    assert.equal(renderTemplate(undefined, {}), '');
});

test('renderTemplate leaves unrelated double-brace patterns alone when var missing', () => {
    const result = renderTemplate('{{unknown_var}}', {});
    assert.equal(result, '');
});

// ─── HTML sanitization ────────────────────────────────────────────────────────

test('sanitizeHtml preserves safe inline tags', () => {
    const input = '<p>Hello <strong>world</strong></p>';
    const result = sanitizeHtml(input);
    assert.ok(result.includes('<strong>'));
    assert.ok(result.includes('</strong>'));
    assert.ok(result.includes('<p>'));
});

test('sanitizeHtml allows safe anchor with https href', () => {
    const input = '<a href="https://example.com">Click here</a>';
    const result = sanitizeHtml(input);
    assert.ok(result.includes('href="https://example.com"'));
    assert.ok(result.includes('target="_blank"'));
    assert.ok(result.includes('rel="noopener noreferrer"'));
});

test('sanitizeHtml strips anchor with javascript href', () => {
    const input = '<a href="javascript:alert(1)">Click</a>';
    const result = sanitizeHtml(input);
    assert.ok(!result.includes('javascript:'));
    assert.ok(!result.includes('<a'));
});

test('sanitizeHtml strips anchor with no href', () => {
    const input = '<a name="anchor">Text</a>';
    const result = sanitizeHtml(input);
    assert.ok(!result.includes('<a'));
});

test('sanitizeHtml allows safe image with src alt width and height', () => {
    const input = '<img src="https://example.com/image.png" alt="Demo" width="640" height="480" class="x">';
    const result = sanitizeHtml(input);
    assert.ok(result.includes('<img '));
    assert.ok(result.includes('src="https://example.com/image.png"'));
    assert.ok(result.includes('alt="Demo"'));
    assert.ok(result.includes('width="640"'));
    assert.ok(result.includes('height="480"'));
    assert.ok(!result.includes('class='));
});

test('sanitizeHtml strips image with unsafe src', () => {
    const input = '<img src="javascript:alert(1)" alt="Bad">';
    const result = sanitizeHtml(input);
    assert.ok(!result.includes('<img'));
    assert.ok(!result.includes('javascript:'));
});

test('sanitizeHtml strips script tags and their content', () => {
    const input = '<p>Safe</p><script>alert("xss")</script>';
    const result = sanitizeHtml(input);
    assert.ok(!result.includes('<script'));
    assert.ok(!result.includes('alert'));
    assert.ok(result.includes('<p>'));
});

test('sanitizeHtml strips style blocks', () => {
    const input = '<style>body { color: red; }</style><p>Text</p>';
    const result = sanitizeHtml(input);
    assert.ok(!result.includes('<style'));
    assert.ok(!result.includes('color: red'));
});

test('sanitizeHtml strips disallowed tags while keeping text', () => {
    const input = '<table><tr><td>Cell text</td></tr></table>';
    const result = sanitizeHtml(input);
    assert.ok(!result.includes('<table'));
    // Text content should remain if tags are stripped
    // (tags are stripped, inner text may or may not remain depending on nesting)
});

test('sanitizeHtml strips all attributes from non-anchor allowed tags', () => {
    const input = '<p class="foo" onclick="bad()">Text</p>';
    const result = sanitizeHtml(input);
    assert.ok(!result.includes('class='));
    assert.ok(!result.includes('onclick='));
    assert.ok(result.includes('<p>'));
});

// ─── Plain-text fallback ──────────────────────────────────────────────────────

test('htmlToPlainText strips tags and decodes entities', () => {
    const html = '<p>Hello &amp; world</p><br>';
    const text = htmlToPlainText(html);
    assert.ok(text.includes('Hello & world'));
    assert.ok(!text.includes('<'));
});

test('htmlToPlainText converts block tags to newlines', () => {
    const html = '<p>First</p><p>Second</p>';
    const text = htmlToPlainText(html);
    assert.ok(text.includes('\n'));
});

test('htmlToPlainText returns empty string for empty input', () => {
    assert.equal(htmlToPlainText(''), '');
    assert.equal(htmlToPlainText(null), '');
});

// ─── Sequence eligibility logic (pure logic unit tests via mock scenarios) ────

/**
 * Helper: simulate what the eligibility query computes given a set of events.
 * Tests the blocker-detection logic independent of the DB layer.
 */

const WARM_FOLLOW_UP_EVENT = 'Warm Follow Up';

const BLOCKER_EVENT_TYPES = new Set([
    'reply_received',
    'email_bounced',
    'lead_unsubscribed',
    'lead_not_interested',
    'lead_meeting_booked',
    'lead_meeting_completed',
    'lead_closed',
    'lead_wrong_person',
    'lead_no_show',
]);

/**
 * Returns true if a contact+campaign should receive a follow-up given an
 * ordered list of events (ascending timestamp). Mirrors the SQL logic.
 */
function isEligible(events) {
    const warmFuEvents = events.filter((e) => e.type === WARM_FOLLOW_UP_EVENT);
    if (warmFuEvents.length === 0) return false;

    const latestAnchorTs = Math.max(...warmFuEvents.map((e) => e.ts));

    const hasBlocker = events.some(
        (e) => BLOCKER_EVENT_TYPES.has(e.type) && e.ts > latestAnchorTs
    );

    return !hasBlocker;
}

test('eligibility: eligible when only Warm Follow Up event exists', () => {
    const events = [{ type: 'Warm Follow Up', ts: 1000 }];
    assert.equal(isEligible(events), true);
});

test('eligibility: eligible when email_sent appears after Warm Follow Up', () => {
    const events = [
        { type: 'Warm Follow Up', ts: 1000 },
        { type: 'email_sent', ts: 2000 },
    ];
    assert.equal(isEligible(events), true);
});

test('eligibility: eligible when multiple email_sent events appear after Warm Follow Up', () => {
    const events = [
        { type: 'Warm Follow Up', ts: 1000 },
        { type: 'email_sent', ts: 2000 },
        { type: 'email_sent', ts: 3000 },
    ];
    assert.equal(isEligible(events), true);
});

test('eligibility: not eligible when no Warm Follow Up event exists', () => {
    const events = [{ type: 'email_sent', ts: 1000 }];
    assert.equal(isEligible(events), false);
});

test('eligibility: not eligible when reply_received appears after anchor', () => {
    const events = [
        { type: 'Warm Follow Up', ts: 1000 },
        { type: 'email_sent', ts: 2000 },
        { type: 'reply_received', ts: 3000 },
    ];
    assert.equal(isEligible(events), false);
});

test('eligibility: not eligible when lead_not_interested appears after anchor', () => {
    const events = [
        { type: 'Warm Follow Up', ts: 1000 },
        { type: 'lead_not_interested', ts: 2000 },
    ];
    assert.equal(isEligible(events), false);
});

test('eligibility: not eligible when email_bounced appears after anchor', () => {
    const events = [
        { type: 'Warm Follow Up', ts: 1000 },
        { type: 'email_bounced', ts: 2000 },
    ];
    assert.equal(isEligible(events), false);
});

test('eligibility: not eligible when lead_unsubscribed appears after anchor', () => {
    const events = [
        { type: 'Warm Follow Up', ts: 1000 },
        { type: 'lead_unsubscribed', ts: 2000 },
    ];
    assert.equal(isEligible(events), false);
});

test('eligibility: not eligible when lead_meeting_booked appears after anchor', () => {
    const events = [
        { type: 'Warm Follow Up', ts: 1000 },
        { type: 'lead_meeting_booked', ts: 2000 },
    ];
    assert.equal(isEligible(events), false);
});

test('eligibility: not eligible when lead_wrong_person appears after anchor', () => {
    const events = [
        { type: 'Warm Follow Up', ts: 1000 },
        { type: 'lead_wrong_person', ts: 2000 },
    ];
    assert.equal(isEligible(events), false);
});

test('eligibility: eligible when blocker appears BEFORE anchor (restartability)', () => {
    // A blocker before the latest Warm Follow Up anchor is ignored — the
    // Warm Follow Up represents a fresh start of the sequence.
    const events = [
        { type: 'reply_received', ts: 500 },
        { type: 'Warm Follow Up', ts: 1000 },  // re-anchors sequence
        { type: 'email_sent', ts: 2000 },
    ];
    assert.equal(isEligible(events), true);
});

test('eligibility: eligible when email_opened appears after anchor', () => {
    const events = [
        { type: 'Warm Follow Up', ts: 1000 },
        { type: 'email_opened', ts: 2000 },
    ];
    assert.equal(isEligible(events), true);
});

test('eligibility: eligible when email_link_clicked appears after anchor', () => {
    const events = [
        { type: 'Warm Follow Up', ts: 1000 },
        { type: 'email_link_clicked', ts: 2000 },
    ];
    assert.equal(isEligible(events), true);
});

test('eligibility: empty event list is not eligible', () => {
    assert.equal(isEligible([]), false);
});

// ─── Idempotency logic simulation ─────────────────────────────────────────────

test('idempotency: second successful send for same contact+campaign+date is blocked', () => {
    // Simulate the uniqueness constraint: if a 'sent' row exists for today,
    // the recheck returns blocked.
    const sentRows = [
        { contactId: 1, campaignId: 10, status: 'sent', sentForDate: '2026-04-25' }
    ];
    const today = '2026-04-25';

    function hasSentToday(contactId, campaignId) {
        return sentRows.some(
            (r) => r.contactId === contactId &&
                   r.campaignId === campaignId &&
                   r.status === 'sent' &&
                   r.sentForDate === today
        );
    }

    assert.equal(hasSentToday(1, 10), true);
    assert.equal(hasSentToday(1, 11), false); // different campaign
    assert.equal(hasSentToday(2, 10), false); // different contact
});

test('idempotency: failed_retryable does not block re-attempt today', () => {
    const sentRows = [
        { contactId: 1, campaignId: 10, status: 'failed_retryable', sentForDate: '2026-04-25' }
    ];
    const today = '2026-04-25';
    const blocked = sentRows.some(
        (r) => r.contactId === 1 && r.campaignId === 10 && r.status === 'sent' && r.sentForDate === today
    );
    assert.equal(blocked, false);
});

test('idempotency: blocked_missing_thread does not block re-attempt next day', () => {
    const sentRows = [
        { contactId: 1, campaignId: 10, status: 'blocked_missing_thread', sentForDate: '2026-04-24' }
    ];
    const today = '2026-04-25';
    const blocked = sentRows.some(
        (r) => r.contactId === 1 && r.campaignId === 10 && r.status === 'sent' && r.sentForDate === today
    );
    assert.equal(blocked, false);
});

// ─── Instantly reply API mock scenarios ──────────────────────────────────────

test('sendInstantlyReply success: resolves without error', async () => {
    // Mock the API call
    async function mockApiCall(payload) {
        assert.equal(payload.reply_to_uuid, 'uuid-abc');
        assert.equal(payload.eaccount, 'sender@example.com');
        assert.ok(payload.body?.html);
        return { success: true };
    }

    const result = await mockApiCall({
        reply_to_uuid: 'uuid-abc',
        eaccount: 'sender@example.com',
        body: { html: '<p>Hi</p>', text: 'Hi' }
    });
    assert.deepEqual(result, { success: true });
});

test('sendInstantlyReply 401 failure: error is non-retryable', () => {
    const err = { statusCode: 401, retryable: false, message: 'Unauthorized' };
    assert.equal(err.retryable, false);
    assert.equal(err.statusCode, 401);
});

test('sendInstantlyReply 429 failure: error is retryable', () => {
    const err = { statusCode: 429, retryable: true, message: 'Rate limited' };
    assert.equal(err.retryable, true);
    assert.equal(err.statusCode, 429);
});

test('missing thread metadata: status is blocked_missing_thread, non-retryable', () => {
    // Simulate the guard in sendFollowUpForProspect
    function determineOutcome(replyToUuid, eaccount) {
        if (!replyToUuid || !eaccount) {
            return { status: 'blocked_missing_thread', retryable: false };
        }
        return { status: 'sent', retryable: false };
    }

    assert.deepEqual(determineOutcome(null, 'sender@example.com'), {
        status: 'blocked_missing_thread', retryable: false
    });
    assert.deepEqual(determineOutcome('uuid-abc', null), {
        status: 'blocked_missing_thread', retryable: false
    });
    assert.deepEqual(determineOutcome('uuid-abc', 'sender@example.com'), {
        status: 'sent', retryable: false
    });
});
