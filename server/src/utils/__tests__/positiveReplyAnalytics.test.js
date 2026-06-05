import test from 'node:test';
import assert from 'node:assert/strict';
import {
    countQualifiedInterestedContacts,
    getLifecycleStateDelta
} from '../positiveReplyAnalytics.js';

const PERIOD_START = '2026-06-01T00:00:00.000Z';
const PERIOD_END = '2026-06-07T23:59:59.999Z';

function event(contactId, eventType, timestamp, options = {}) {
    const id = options.id || `${contactId}-${eventType}-${timestamp}`;
    return {
        id,
        contact_id: contactId,
        event_type: eventType,
        event_timestamp: timestamp,
        source: options.source ?? null
    };
}

test('getLifecycleStateDelta maps interested, progressions, and disqualifiers', () => {
    assert.equal(getLifecycleStateDelta('lead_interested'), 1);
    assert.equal(getLifecycleStateDelta('lead_meeting_booked'), 1);
    assert.equal(getLifecycleStateDelta('lead_meeting_completed'), 1);
    assert.equal(getLifecycleStateDelta('interested_reply_sent'), 1);
    assert.equal(getLifecycleStateDelta('email_sent', 'server_follow_up'), 1);
    assert.equal(getLifecycleStateDelta('lead_not_interested'), -1);
    assert.equal(getLifecycleStateDelta('lead_neutral'), -1);
    assert.equal(getLifecycleStateDelta('lead_wrong_person'), -1);
    assert.equal(getLifecycleStateDelta('bad fit'), -1);
    assert.equal(getLifecycleStateDelta('lead_out_of_office'), 0);
    assert.equal(getLifecycleStateDelta('email_sent'), 0);
});

test('counts contact with in-window interested and no disqualifier', () => {
    const count = countQualifiedInterestedContacts([
        event(1, 'lead_interested', '2026-06-03T10:00:00.000Z')
    ], { periodStart: PERIOD_START, periodEnd: PERIOD_END });

    assert.equal(count, 1);
});

test('does not count contact interested only outside the window', () => {
    const count = countQualifiedInterestedContacts([
        event(1, 'lead_interested', '2026-05-20T10:00:00.000Z')
    ], { periodStart: PERIOD_START, periodEnd: PERIOD_END });

    assert.equal(count, 0);
});

test('disqualifies when final lifecycle event is negative across full history', () => {
    const count = countQualifiedInterestedContacts([
        event(1, 'lead_interested', '2026-06-03T10:00:00.000Z'),
        event(1, 'lead_not_interested', '2026-06-10T10:00:00.000Z')
    ], { periodStart: PERIOD_START, periodEnd: PERIOD_END });

    assert.equal(count, 0);
});

test('re-qualifies after wrong person when interested returns in-window', () => {
    const count = countQualifiedInterestedContacts([
        event(1, 'lead_interested', '2026-06-02T10:00:00.000Z'),
        event(1, 'lead_wrong_person', '2026-06-03T10:00:00.000Z'),
        event(1, 'lead_interested', '2026-06-04T10:00:00.000Z')
    ], { periodStart: PERIOD_START, periodEnd: PERIOD_END });

    assert.equal(count, 1);
});

test('out of office after interested does not disqualify', () => {
    const count = countQualifiedInterestedContacts([
        event(1, 'lead_interested', '2026-06-03T10:00:00.000Z'),
        event(1, 'lead_out_of_office', '2026-06-05T10:00:00.000Z')
    ], { periodStart: PERIOD_START, periodEnd: PERIOD_END });

    assert.equal(count, 1);
});

test('out of office only without interested in window does not count', () => {
    const count = countQualifiedInterestedContacts([
        event(1, 'lead_out_of_office', '2026-06-03T10:00:00.000Z')
    ], { periodStart: PERIOD_START, periodEnd: PERIOD_END });

    assert.equal(count, 0);
});

test('bad fit disqualifies even when interested was in-window', () => {
    const count = countQualifiedInterestedContacts([
        event(1, 'lead_interested', '2026-06-03T10:00:00.000Z'),
        event(1, 'bad fit', '2026-06-08T10:00:00.000Z')
    ], { periodStart: PERIOD_START, periodEnd: PERIOD_END });

    assert.equal(count, 0);
});

test('still counts when final progression is meeting booked', () => {
    const count = countQualifiedInterestedContacts([
        event(1, 'lead_interested', '2026-06-03T10:00:00.000Z'),
        event(1, 'lead_meeting_booked', '2026-06-06T10:00:00.000Z')
    ], { periodStart: PERIOD_START, periodEnd: PERIOD_END });

    assert.equal(count, 1);
});

test('still counts when final progression is warm follow-up sent', () => {
    const count = countQualifiedInterestedContacts([
        event(1, 'lead_interested', '2026-06-03T10:00:00.000Z'),
        event(1, 'email_sent', '2026-06-06T10:00:00.000Z', { source: 'server_follow_up' })
    ], { periodStart: PERIOD_START, periodEnd: PERIOD_END });

    assert.equal(count, 1);
});

test('meeting booked then bad fit does not count', () => {
    const count = countQualifiedInterestedContacts([
        event(1, 'lead_interested', '2026-06-03T10:00:00.000Z'),
        event(1, 'lead_meeting_booked', '2026-06-05T10:00:00.000Z'),
        event(1, 'bad fit', '2026-06-08T10:00:00.000Z')
    ], { periodStart: PERIOD_START, periodEnd: PERIOD_END });

    assert.equal(count, 0);
});

test('counts unique contacts only once', () => {
    const count = countQualifiedInterestedContacts([
        event(1, 'lead_interested', '2026-06-02T10:00:00.000Z'),
        event(1, 'lead_interested', '2026-06-04T10:00:00.000Z'),
        event(2, 'lead_interested', '2026-06-03T10:00:00.000Z')
    ], { periodStart: PERIOD_START, periodEnd: PERIOD_END });

    assert.equal(count, 2);
});
