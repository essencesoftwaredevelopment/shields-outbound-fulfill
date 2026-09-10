import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
    verifyCalendlySignature,
    parseScheduledEventStartTime,
    parseWebhookPayload,
    resolveTimelineEventTimestamp,
    resolveLatestCampaignForContact,
    LATEST_CAMPAIGN_FOR_CONTACT_SQL
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

test('LATEST_CAMPAIGN_FOR_CONTACT_SQL prefers Instantly events before membership', () => {
    assert.match(LATEST_CAMPAIGN_FOR_CONTACT_SQL, /cie\.source <> 'calendly'/);
    assert.match(LATEST_CAMPAIGN_FOR_CONTACT_SQL, /cie\.event_timestamp <= \$2/);
    assert.match(LATEST_CAMPAIGN_FOR_CONTACT_SQL, /FROM contact_instantly_campaigns cic/);
    assert.match(LATEST_CAMPAIGN_FOR_CONTACT_SQL, /ORDER BY rank/);
});

test('resolveLatestCampaignForContact: returns campaign from db row', async () => {
    const db = {
        query: async (sql, params) => {
            assert.equal(params[0], 41823);
            assert.equal(params[1].toISOString(), '2026-09-04T21:01:34.133Z');
            assert.equal(sql, LATEST_CAMPAIGN_FOR_CONTACT_SQL);
            return {
                rows: [{ campaign_id: 408824, instantly_campaign_id: 'b206f8eb-afb3-4b8b-bb3a-60bd5bc1fbd3' }]
            };
        }
    };

    const campaign = await resolveLatestCampaignForContact(41823, {
        at: new Date('2026-09-04T21:01:34.133Z'),
        db
    });
    assert.deepEqual(campaign, {
        campaign_id: 408824,
        instantly_campaign_id: 'b206f8eb-afb3-4b8b-bb3a-60bd5bc1fbd3'
    });
});

test('resolveLatestCampaignForContact: returns null when contact has no campaign', async () => {
    const db = { query: async () => ({ rows: [] }) };
    const campaign = await resolveLatestCampaignForContact(99, { db });
    assert.equal(campaign, null);
});

test('resolveLatestCampaignForContact: skips lookup without a contact id', async () => {
    let called = false;
    const db = { query: async () => { called = true; return { rows: [] }; } };
    assert.equal(await resolveLatestCampaignForContact(null, { db }), null);
    assert.equal(called, false);
});
