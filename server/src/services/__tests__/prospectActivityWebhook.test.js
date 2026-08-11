import assert from 'node:assert/strict';
import test from 'node:test';
import {
    parseProspectActivityPayload,
    titleToEventType
} from '../prospectActivityWebhook.js';

test('titleToEventType: slugifies freeform titles', () => {
    assert.equal(titleToEventType('Lead magnet view'), 'lead_magnet_view');
    assert.equal(titleToEventType('Meeting booking alteration'), 'meeting_booking_alteration');
    assert.equal(titleToEventType('  Already_Snake  '), 'already_snake');
});

test('titleToEventType: empty title returns null', () => {
    assert.equal(titleToEventType(''), null);
    assert.equal(titleToEventType('   '), null);
    assert.equal(titleToEventType(null), null);
});

test('parseProspectActivityPayload: accepts flexible field names', () => {
    const parsed = parseProspectActivityPayload({
        activity_title: 'Lead magnet view',
        activity_description: 'Opened the audit PDF',
        lead_email: 'Founder@Brand.COM',
        Domain: 'https://www.brand.com/path',
        contactId: '42',
        idempotencyKey: 'evt-1',
        metadata: { source_url: 'https://example.com' }
    });

    assert.equal(parsed.title, 'Lead magnet view');
    assert.equal(parsed.description, 'Opened the audit PDF');
    assert.equal(parsed.email, 'founder@brand.com');
    assert.equal(parsed.domain, 'brand.com');
    assert.equal(parsed.contactId, 42);
    assert.equal(parsed.idempotencyKey, 'evt-1');
    assert.deepEqual(parsed.metadata, { source_url: 'https://example.com' });
});

test('parseProspectActivityPayload: prefers title/description aliases', () => {
    const parsed = parseProspectActivityPayload({
        title: 'Primary title',
        event_type: 'ignored_when_title_present',
        description: 'Primary description',
        message_text: 'ignored'
    });

    assert.equal(parsed.title, 'Primary title');
    assert.equal(parsed.description, 'Primary description');
});
