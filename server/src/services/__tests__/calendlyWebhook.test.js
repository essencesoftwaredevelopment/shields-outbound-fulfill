import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
    verifyCalendlySignature,
    parseScheduledEventStartTime,
    parseWebhookPayload,
    resolveTimelineEventTimestamp
} from '../calendlyWebhook.js';

test('verifyCalendlySignature: valid signature passes', () => {
    const secret = 'test-signing-key';
    const rawBody = Buffer.from(JSON.stringify({ event: 'invitee.created' }));
    const timestamp = '1700000000';
    const signature = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.`)
        .update(rawBody)
        .digest('hex');
    const header = `t=${timestamp},v1=${signature}`;

    const result = verifyCalendlySignature(rawBody, header, secret);
    assert.equal(result.valid, true);
});

test('verifyCalendlySignature: invalid signature fails', () => {
    const rawBody = Buffer.from('{}');
    const result = verifyCalendlySignature(rawBody, 't=1,v1=deadbeef', 'secret');
    assert.equal(result.valid, false);
});

test('parseScheduledEventStartTime: returns ISO timestamp or null', () => {
    assert.equal(parseScheduledEventStartTime('2026-06-18T10:30:00.000000Z'), '2026-06-18T10:30:00.000Z');
    assert.equal(parseScheduledEventStartTime(''), null);
    assert.equal(parseScheduledEventStartTime(null), null);
    assert.equal(parseScheduledEventStartTime('not-a-date'), null);
});

test('verifyCalendlySignature: skips when secret not configured', () => {
    const result = verifyCalendlySignature(Buffer.from('{}'), null, '');
    assert.equal(result.valid, true);
    assert.equal(result.skipped, true);
});

test('parseWebhookPayload: extracts invitee email and scheduled event uri', () => {
    const body = {
        event: 'invitee.created',
        payload: {
            email: 'Jane@Example.com',
            name: 'Jane Doe',
            event: 'https://api.calendly.com/scheduled_events/EVT123',
            uri: 'https://api.calendly.com/scheduled_events/EVT123/invitees/INV456',
            timezone: 'America/New_York'
        }
    };

    const parsed = parseWebhookPayload(body);
    assert.equal(parsed.eventType, 'invitee.created');
    assert.equal(parsed.email, 'jane@example.com');
    assert.equal(parsed.inviteeName, 'Jane Doe');
    assert.equal(parsed.scheduledEventUri, 'https://api.calendly.com/scheduled_events/EVT123');
    assert.equal(parsed.inviteeUri, 'https://api.calendly.com/scheduled_events/EVT123/invitees/INV456');
    assert.equal(parsed.scheduledEventStartTime, null);
});

test('parseWebhookPayload: extracts payload.scheduled_event.start_time', () => {
    const body = {
        event: 'invitee.created',
        payload: {
            email: 'jane@example.com',
            scheduled_event: {
                start_time: '2026-06-18T10:30:00.000000Z'
            }
        }
    };

    const parsed = parseWebhookPayload(body);
    assert.equal(parsed.scheduledEventStartTime, '2026-06-18T10:30:00.000Z');
});

test('resolveTimelineEventTimestamp: invitee.created uses booking time, not meeting start', () => {
    const body = {
        event: 'invitee.created',
        created_at: '2026-06-17T09:16:52.663Z',
        payload: {
            created_at: '2026-06-17T09:16:51.441028Z',
            scheduled_event: {
                start_time: '2026-06-18T10:30:00.000000Z'
            }
        }
    };

    const parsed = parseWebhookPayload(body);
    const timestamp = resolveTimelineEventTimestamp({
        eventType: parsed.eventType,
        invitee: parsed.invitee,
        payload: parsed.payload,
        body
    });

    assert.equal(timestamp.toISOString(), '2026-06-17T09:16:51.441Z');
});

test('resolveTimelineEventTimestamp: invitee.canceled uses cancellation time', () => {
    const body = {
        event: 'invitee.canceled',
        created_at: '2026-06-17T11:00:00.000Z',
        payload: {
            created_at: '2026-06-17T09:16:51.441028Z',
            updated_at: '2026-06-17T11:00:00.000Z',
            scheduled_event: {
                start_time: '2026-06-18T10:30:00.000000Z'
            }
        }
    };

    const parsed = parseWebhookPayload(body);
    const timestamp = resolveTimelineEventTimestamp({
        eventType: parsed.eventType,
        invitee: parsed.invitee,
        payload: parsed.payload,
        body
    });

    assert.equal(timestamp.toISOString(), '2026-06-17T11:00:00.000Z');
});

test('resolveTimelineEventTimestamp: prefers enriched invitee created_at', () => {
    const timestamp = resolveTimelineEventTimestamp({
        eventType: 'invitee.created',
        invitee: { created_at: '2026-06-17T09:16:51.441028Z' },
        payload: {
            scheduled_event: { start_time: '2026-06-18T10:30:00.000000Z' }
        },
        body: { created_at: '2026-06-17T09:16:52.663Z' },
        enrichedInvitee: { created_at: '2026-06-17T09:16:50.000000Z' }
    });

    assert.equal(timestamp.toISOString(), '2026-06-17T09:16:50.000Z');
});
