import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { verifyCalendlySignature, parseWebhookPayload } from '../calendlyWebhook.js';

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
});
