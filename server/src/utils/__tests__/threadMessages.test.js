import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThreadMessages, stripQuotedHistory } from '../threadMessages.js';

test('stripQuotedHistory cuts Gmail, Outlook and ">" quoted blocks', () => {
    assert.equal(
        stripQuotedHistory('Yes I’d be open to that!\n\nOn Wed, Sep 2, 2026 at 4:22 PM Sofia <s@x.com> wrote:\n> Hi Madeline'),
        'Yes I’d be open to that!'
    );
    assert.equal(
        stripQuotedHistory('Sounds good.\n\nFrom: Sofia <s@x.com>\nSent: Tuesday\nTo: me'),
        'Sounds good.'
    );
    assert.equal(stripQuotedHistory('Thanks\n> earlier text'), 'Thanks');
    assert.equal(stripQuotedHistory('On Wed wrote:'), 'On Wed wrote:');
    assert.equal(stripQuotedHistory('   '), '');
});

test('buildThreadMessages classifies, dedupes categorised twins and orders oldest first', () => {
    const rows = [
        {
            id: 5, event_type: 'lead_interested', event_timestamp: '2026-09-02T20:50:07Z', lead_email: 'madeline@shop.com',
            payload: { reply_text: 'Yes I’d be open to that!\n\nOn Wed, Sep 2 Sofia wrote:\n> Hi', reply_subject: 'Re: Hi Madeline' }
        },
        {
            id: 4, event_type: 'reply_received', event_timestamp: '2026-09-02T20:50:04Z', lead_email: 'madeline@shop.com', email_account: 'sofia@agency.com',
            payload: { reply_text: 'Yes I’d be open to that!\n\nOn Wed, Sep 2 Sofia wrote:\n> Hi', reply_subject: 'Re: Hi Madeline' }
        },
        {
            id: 1, event_type: 'email_sent', event_timestamp: '2026-09-02T20:22:13Z', email_account: 'sofia@agency.com', step: 1,
            payload: { email_html: '<p>Hi Madeline,</p><p>Quick one about your welcome flow.</p>', email_subject: 'Hi Madeline' }
        },
        {
            id: 7, event_type: 'interested_reply_sent', event_timestamp: '2026-09-02T21:03:52Z', email_account: 'sofia@agency.com',
            message_text: 'Hi Madeline, perfect.\n\nThe easiest next step is a quick demo.',
            payload: { email_text: 'Hi Madeline, perfect.\n\nThe easiest next step is a quick demo.', subject: 'Re: Hi Madeline' }
        },
        {
            id: 8, event_type: 'Warm Follow Up', event_timestamp: '2026-09-02T21:03:53Z',
            payload: { reply_text: 'Yes I’d be open to that!', reply_subject: 'Re: Hi Madeline' }
        },
        {
            id: 9, event_type: 'email_sent', event_timestamp: '2026-09-03T09:00:21Z', email_account: 'sofia@agency.com',
            message_text: 'Hey Madeline, best next step is a short demo.',
            payload: { email_text: 'Hey Madeline, best next step is a short demo.', follow_up_send_id: 12, subject: 'Re: Hi Madeline' }
        },
        { id: 10, event_type: 'warm_follow_up_removed', event_timestamp: '2026-09-04T09:00:00Z', message_text: 'Removed from warm follow-ups', payload: { source: 'app' } },
        { id: 11, event_type: 'lead_interested', event_timestamp: '2026-09-04T10:00:00Z', message_text: 'Interested', payload: { interest_value: 1 } },
        { id: 12, event_type: 'campaign_completed_for_lead_without_reply', event_timestamp: '2026-09-05T10:00:00Z', payload: {} }
    ];

    const thread = buildThreadMessages(rows, { leadEmail: 'madeline@shop.com' });
    assert.deepEqual(thread.map((m) => [m.id, m.direction, m.kind]), [
        [1, 'outbound', 'campaign'],
        [4, 'inbound', 'reply'],
        [7, 'outbound', 'autoresponder'],
        [9, 'outbound', 'follow_up']
    ]);
    assert.equal(thread[0].text, 'Hi Madeline,\nQuick one about your welcome flow.');
    assert.equal(thread[0].subject, 'Hi Madeline');
    assert.equal(thread[0].from, 'sofia@agency.com');
    assert.equal(thread[1].text, 'Yes I’d be open to that!');
    assert.equal(thread[1].from, 'madeline@shop.com');
    assert.equal(thread[1].sentAt, '2026-09-02T20:50:04.000Z');
    assert.equal(thread[2].kind, 'autoresponder');
});

test('buildThreadMessages tolerates string payloads, missing timestamps and honours the limit', () => {
    const rows = [
        { id: 1, event_type: 'reply_received', payload: '{"reply_text":"first"}' },
        { id: 2, event_type: 'reply_received', event_timestamp: 'not a date', payload: '{broken' , message_text: 'second' },
        { id: 3, event_type: 'manual_reply_sent', event_timestamp: '2026-09-01T00:00:00Z', payload: { email_text: 'third', sent_by: 'jacques' } }
    ];
    const thread = buildThreadMessages(rows, { limit: 2 });
    assert.equal(thread.length, 2);
    assert.ok(thread.every((m) => m.text));
    assert.equal(buildThreadMessages(null).length, 0);
});
