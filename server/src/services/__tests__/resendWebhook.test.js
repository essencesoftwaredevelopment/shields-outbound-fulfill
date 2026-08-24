import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
    buildResendFingerprint,
    buildResendTimelineMessage,
    mapResendEventType,
    parseResendWebhookEvent,
    SVIX_TIMESTAMP_TOLERANCE_SEC,
    verifyResendSignature
} from '../resendWebhook.js';

function signPayload(rawBody, secret, { id = 'msg_test', timestamp = String(Math.floor(Date.now() / 1000)) } = {}) {
    const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
    const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const signature = crypto
        .createHmac('sha256', secretBytes)
        .update(`${id}.${timestamp}.${payload}`)
        .digest('base64');
    return {
        id,
        timestamp,
        signature,
        headers: {
            'svix-id': id,
            'svix-timestamp': timestamp,
            'svix-signature': `v1,${signature}`
        }
    };
}

test('mapResendEventType: maps delivery events onto timeline types', () => {
    assert.equal(mapResendEventType('email.sent'), 'email_sent');
    assert.equal(mapResendEventType('email.opened'), 'email_opened');
    assert.equal(mapResendEventType('email.clicked'), 'email_link_clicked');
    assert.equal(mapResendEventType('email.bounced'), 'email_bounced');
    assert.equal(mapResendEventType('email.complained'), 'email_complained');
    assert.equal(mapResendEventType('email.failed'), 'email_failed');
    assert.equal(mapResendEventType('contact.created'), null);
});

test('verifyResendSignature: valid svix signature passes', () => {
    const secret = `whsec_${Buffer.from('test-signing-key').toString('base64')}`;
    const rawBody = Buffer.from(JSON.stringify({ type: 'email.sent' }));
    const signed = signPayload(rawBody, secret);
    const result = verifyResendSignature(rawBody, signed.headers, secret);
    assert.equal(result.valid, true);
});

test('verifyResendSignature: invalid signature fails', () => {
    const secret = `whsec_${Buffer.from('test-signing-key').toString('base64')}`;
    const rawBody = Buffer.from('{}');
    const result = verifyResendSignature(rawBody, {
        'svix-id': 'msg_1',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,deadbeef'
    }, secret);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'signature_mismatch');
});

test('verifyResendSignature: skips when secret not configured', () => {
    const result = verifyResendSignature(Buffer.from('{}'), {}, '');
    assert.equal(result.valid, true);
    assert.equal(result.skipped, true);
});

test('verifyResendSignature: rejects stale timestamps', () => {
    const secret = `whsec_${Buffer.from('test-signing-key').toString('base64')}`;
    const rawBody = Buffer.from('{}');
    const stale = String(Math.floor(Date.now() / 1000) - SVIX_TIMESTAMP_TOLERANCE_SEC - 10);
    const signed = signPayload(rawBody, secret, { timestamp: stale });
    const result = verifyResendSignature(rawBody, signed.headers, secret);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'timestamp_out_of_tolerance');
});

test('parseResendWebhookEvent: extracts recipient, subject, and email id', () => {
    const parsed = parseResendWebhookEvent({
        type: 'email.sent',
        created_at: '2026-08-24T21:00:00.000Z',
        data: {
            email_id: 'ae2014de-c168-4c61-8267-70d2662a1ce1',
            from: 'Jacques @ Essence Retention <team@ai.essenceretention.com>',
            to: ['Jane@Brand.COM'],
            subject: 'Looking forward to our call tomorrow',
            template_id: '5d47c321-7d73-480c-b935-cb355ffe8131',
            tags: { category: 'discovery' }
        }
    });

    assert.equal(parsed.timelineEventType, 'email_sent');
    assert.deepEqual(parsed.emails, ['jane@brand.com']);
    assert.equal(parsed.subject, 'Looking forward to our call tomorrow');
    assert.equal(parsed.emailId, 'ae2014de-c168-4c61-8267-70d2662a1ce1');
    assert.equal(parsed.templateId, '5d47c321-7d73-480c-b935-cb355ffe8131');
    assert.equal(parsed.createdAt, '2026-08-24T21:00:00.000Z');
});

test('parseResendWebhookEvent: captures clicked link', () => {
    const parsed = parseResendWebhookEvent({
        type: 'email.clicked',
        data: {
            to: ['lead@brand.com'],
            subject: 'Case study',
            click: { link: 'https://essenceretention.com/aer' }
        }
    });
    assert.equal(parsed.timelineEventType, 'email_link_clicked');
    assert.equal(parsed.clickUrl, 'https://essenceretention.com/aer');
});

test('buildResendTimelineMessage: uses subject, and appends click URL', () => {
    assert.equal(
        buildResendTimelineMessage({
            timelineEventType: 'email_sent',
            subject: 'See you tomorrow'
        }),
        'See you tomorrow'
    );
    assert.equal(
        buildResendTimelineMessage({
            timelineEventType: 'email_link_clicked',
            subject: 'Case study',
            clickUrl: 'https://example.com'
        }),
        'Case study\nhttps://example.com'
    );
});

test('buildResendFingerprint: svix id + contact is stable', () => {
    const a = buildResendFingerprint({ svixId: 'msg_1', contactId: 42 });
    const b = buildResendFingerprint({ svixId: 'msg_1', contactId: 42 });
    const c = buildResendFingerprint({ svixId: 'msg_1', contactId: 43 });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[a-f0-9]{64}$/);
});
