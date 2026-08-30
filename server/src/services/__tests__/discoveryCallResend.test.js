import assert from 'node:assert/strict';
import test from 'node:test';
import {
    brandNameFromDomain,
    buildDiscoveryCallBookedPayload,
    formatCallDate,
    formatCallDateRelative,
    isEssenceAiDemoEvent,
    notifyEssenceAiDemoBooked,
    splitPersonName
} from '../discoveryCallResend.js';
import {
    ESSENCE_RETENTION_AGENCY_ID,
    ESSENCE_RETENTION_CLIENT_SLUG
} from '../resendScope.js';

const ESSENCE_RETENTION_SCOPE = {
    agencyId: ESSENCE_RETENTION_AGENCY_ID,
    clientSlug: ESSENCE_RETENTION_CLIENT_SLUG
};

const DEMO_EVENT_TYPE = 'https://api.calendly.com/event_types/30336f6d-1955-4c5f-ad3c-49f319bd61e3';

test('isEssenceAiDemoEvent: matches event name', () => {
    assert.equal(isEssenceAiDemoEvent({ eventName: 'ESSENCE AI Demo' }), true);
    assert.equal(isEssenceAiDemoEvent({ eventName: 'Essence AI demo' }), true);
});

test('isEssenceAiDemoEvent: matches Calendly event type UUID', () => {
    assert.equal(isEssenceAiDemoEvent({
        eventName: null,
        scheduledEvent: { event_type: DEMO_EVENT_TYPE }
    }), true);
});

test('isEssenceAiDemoEvent: ignores other Calendly event types', () => {
    assert.equal(isEssenceAiDemoEvent({ eventName: 'Discovery Call' }), false);
    assert.equal(isEssenceAiDemoEvent({ eventName: 'Audit Walkthrough' }), false);
    assert.equal(isEssenceAiDemoEvent({
        scheduledEvent: { name: 'Catch Up + Klaviyo Progress Update' }
    }), false);
});

test('splitPersonName: prefers explicit first/last', () => {
    assert.deepEqual(
        splitPersonName({ firstName: 'Kristina', lastName: 'Ejem', fullName: 'Someone Else' }),
        { firstName: 'Kristina', lastName: 'Ejem' }
    );
});

test('splitPersonName: splits full name when first_name is missing', () => {
    assert.deepEqual(
        splitPersonName({ fullName: 'Celia Chiang' }),
        { firstName: 'Celia', lastName: 'Chiang' }
    );
});

test('brandNameFromDomain: title-cases the SLD', () => {
    assert.equal(brandNameFromDomain('Www.girlsjustwannabox.com'), 'Girlsjustwannabox');
    assert.equal(brandNameFromDomain('https://the-woods-spirit.co'), 'The Woods Spirit');
});

test('formatCallDateRelative: today / tomorrow / weekday in invitee timezone', () => {
    const now = new Date('2026-08-12T15:00:00.000Z');
    assert.equal(
        formatCallDateRelative('2026-08-12T18:00:00.000Z', 'America/New_York', now),
        'today at 2:00 PM'
    );
    assert.equal(
        formatCallDateRelative('2026-08-13T18:00:00.000Z', 'America/New_York', now),
        'tomorrow at 2:00 PM'
    );
    assert.match(
        formatCallDateRelative('2026-08-14T18:00:00.000Z', 'America/New_York', now),
        /Friday at 2:00 PM/
    );
});

test('formatCallDate: includes weekday, date, and timezone', () => {
    const formatted = formatCallDate('2026-08-13T18:00:00.000Z', 'America/New_York');
    assert.match(formatted, /Thursday/);
    assert.match(formatted, /August 13, 2026/);
    assert.match(formatted, /2:00 PM/);
});

test('buildDiscoveryCallBookedPayload: maps ESSENCE AI Demo booking fields', () => {
    const built = buildDiscoveryCallBookedPayload({
        email: 'kjem@girlsjustwannabox.com',
        inviteeName: 'Kristina Ejem',
        invitee: {
            first_name: 'Kristina',
            last_name: 'Ejem',
            timezone: 'America/New_York',
            reschedule_url: 'https://calendly.com/reschedulings/abc'
        },
        scheduledEvent: {
            name: 'ESSENCE AI Demo',
            start_time: '2026-08-13T18:00:00.000000Z',
            location: { join_url: 'https://calendly.com/events/abc/google_meet' },
            event_memberships: [{ user_name: 'Jacques' }]
        },
        questionsAndAnswers: [
            { question: 'Website', answer: 'Www.girlsjustwannabox.com' }
        ],
        location: 'https://calendly.com/events/abc/google_meet',
        startTime: '2026-08-13T18:00:00.000000Z',
        contact: { domain: 'girlsjustwannabox.com', uses_klaviyo: null },
        industry: 'beauty_skincare',
        now: new Date('2026-08-12T15:00:00.000Z')
    });

    assert.equal(built.email, 'kjem@girlsjustwannabox.com');
    assert.equal(built.firstName, 'Kristina');
    assert.equal(built.lastName, 'Ejem');
    assert.equal(built.eventPayload.meeting_join_link, 'https://calendly.com/events/abc/google_meet');
    assert.equal(built.eventPayload.reschedule_link, 'https://calendly.com/reschedulings/abc');
    assert.equal(built.eventPayload.inviter_name, 'Jacques');
    assert.equal(built.eventPayload.brand_name, 'Girlsjustwannabox');
    assert.equal(built.eventPayload.domain, 'girlsjustwannabox.com');
    assert.equal(built.eventPayload.esp, 'Klaviyo');
    assert.equal(built.eventPayload.industry, 'beauty_skincare');
    assert.equal(built.eventPayload.call_date_relative, 'tomorrow at 2:00 PM');
    assert.match(built.eventPayload.call_date, /Thursday/);
});

test('buildDiscoveryCallBookedPayload: maps unrouted industries to fashion fallback', () => {
    const built = buildDiscoveryCallBookedPayload({
        email: 'a@b.com',
        invitee: { first_name: 'A', last_name: 'B', timezone: 'UTC' },
        scheduledEvent: {
            location: { join_url: 'https://calendly.com/events/x/google_meet' }
        },
        startTime: '2026-08-13T18:00:00.000Z',
        industry: 'home_garden',
        now: new Date('2026-08-12T15:00:00.000Z')
    });
    assert.equal(built.eventPayload.industry, 'fashion_apparel');
});

test('buildDiscoveryCallBookedPayload: keeps a live food industry', () => {
    const built = buildDiscoveryCallBookedPayload({
        email: 'a@b.com',
        invitee: { first_name: 'A', last_name: 'B', timezone: 'UTC' },
        scheduledEvent: {
            location: { join_url: 'https://calendly.com/events/x/google_meet' }
        },
        startTime: '2026-08-13T18:00:00.000Z',
        industry: 'food_beverage',
        now: new Date('2026-08-12T15:00:00.000Z')
    });
    assert.equal(built.eventPayload.industry, 'food_beverage');
});

test('buildDiscoveryCallBookedPayload: missing industry still falls back to fashion', () => {
    const built = buildDiscoveryCallBookedPayload({
        email: 'a@b.com',
        invitee: { first_name: 'A', last_name: 'B', timezone: 'UTC' },
        scheduledEvent: {
            location: { join_url: 'https://calendly.com/events/x/google_meet' }
        },
        startTime: '2026-08-13T18:00:00.000Z',
        now: new Date('2026-08-12T15:00:00.000Z')
    });
    assert.equal(built.eventPayload.industry, 'fashion_apparel');
});

test('notifyEssenceAiDemoBooked: skips non-demo events', async () => {
    const result = await notifyEssenceAiDemoBooked({
        eventType: 'invitee.created',
        eventName: 'Discovery Call',
        email: 'a@b.com'
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'not_essence_ai_demo');
});

test('notifyEssenceAiDemoBooked: skips cancellations', async () => {
    const result = await notifyEssenceAiDemoBooked({
        eventType: 'invitee.canceled',
        eventName: 'ESSENCE AI Demo',
        email: 'a@b.com'
    });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'not_invitee_created');
});

test('notifyEssenceAiDemoBooked: upserts contact then sends event', async () => {
    const calls = [];
    const client = {
        contacts: {
            get: async ({ email }) => {
                calls.push(['get', email]);
                return { data: null, error: { statusCode: 404 } };
            },
            create: async (params) => {
                calls.push(['create', params]);
                return { data: { id: 'contact_1' }, error: null };
            },
            update: async () => ({ data: null, error: null })
        },
        events: {
            send: async (params) => {
                calls.push(['send', params]);
                return { data: { id: 'evt_1' }, error: null };
            }
        }
    };

    const result = await notifyEssenceAiDemoBooked({
        eventType: 'invitee.created',
        eventName: 'ESSENCE AI Demo',
        ...ESSENCE_RETENTION_SCOPE,
        email: 'celia@thewoodsspiritco.com',
        inviteeName: 'Celia Chiang',
        invitee: {
            first_name: 'Celia',
            last_name: 'Chiang',
            timezone: 'America/Vancouver',
            reschedule_url: 'https://calendly.com/reschedulings/xyz'
        },
        scheduledEvent: {
            name: 'ESSENCE AI Demo',
            event_type: DEMO_EVENT_TYPE,
            location: { join_url: 'https://calendly.com/events/xyz/google_meet' },
            event_memberships: [{ user_name: 'Jacques' }]
        },
        questionsAndAnswers: [{ question: 'Website', answer: 'thewoodsspiritco.com' }],
        location: 'https://calendly.com/events/xyz/google_meet',
        startTime: '2026-08-10T17:45:00.000Z',
        now: new Date('2026-08-04T17:49:32.000Z')
    }, { client });

    assert.equal(result.skipped, false);
    assert.equal(result.contact_created, true);
    assert.equal(result.email, 'celia@thewoodsspiritco.com');
    assert.equal(calls[0][0], 'get');
    assert.equal(calls[1][0], 'create');
    assert.deepEqual(calls[1][1], {
        email: 'celia@thewoodsspiritco.com',
        firstName: 'Celia',
        lastName: 'Chiang'
    });
    assert.equal(calls[2][0], 'send');
    assert.equal(calls[2][1].event, 'Discovery Call Booked');
    assert.equal(calls[2][1].email, 'celia@thewoodsspiritco.com');
    assert.equal(calls[2][1].payload.meeting_join_link, 'https://calendly.com/events/xyz/google_meet');
    assert.equal(calls[2][1].payload.brand_name, 'Thewoodsspiritco');
});

test('notifyEssenceAiDemoBooked: updates existing Resend contact', async () => {
    const client = {
        contacts: {
            get: async () => ({ data: { id: 'existing_1' }, error: null }),
            create: async () => {
                throw new Error('should not create');
            },
            update: async (params) => {
                assert.equal(params.email, 'kjem@girlsjustwannabox.com');
                assert.equal(params.firstName, 'Kristina');
                return { data: { id: 'existing_1' }, error: null };
            }
        },
        events: {
            send: async () => ({ data: { id: 'evt_2' }, error: null })
        }
    };

    const result = await notifyEssenceAiDemoBooked({
        eventType: 'invitee.created',
        eventName: 'ESSENCE AI Demo',
        ...ESSENCE_RETENTION_SCOPE,
        email: 'kjem@girlsjustwannabox.com',
        invitee: { first_name: 'Kristina', last_name: 'Ejem', timezone: 'UTC' },
        scheduledEvent: {
            location: { join_url: 'https://meet.example/join' }
        },
        startTime: '2026-08-13T18:00:00.000Z'
    }, { client });

    assert.equal(result.skipped, false);
    assert.equal(result.contact_created, false);
    assert.equal(result.contact_id, 'existing_1');
});

test('notifyEssenceAiDemoBooked: skips bookings outside essence-retention', async () => {
    const client = {
        contacts: {
            get: async () => {
                throw new Error('should not touch Resend');
            }
        },
        events: {
            send: async () => {
                throw new Error('should not touch Resend');
            }
        }
    };
    const demo = {
        eventType: 'invitee.created',
        eventName: 'ESSENCE AI Demo',
        email: 'a@b.com',
        invitee: { first_name: 'A', timezone: 'UTC' },
        scheduledEvent: { location: { join_url: 'https://meet.example/join' } },
        startTime: '2026-08-13T18:00:00.000Z'
    };

    const missing = await notifyEssenceAiDemoBooked(demo, { client });
    assert.equal(missing.skipped, true);
    assert.equal(missing.reason, 'not_essence_retention_client');

    const otherClient = await notifyEssenceAiDemoBooked({
        ...demo,
        agencyId: ESSENCE_RETENTION_AGENCY_ID,
        clientSlug: 'vulcan-digital'
    }, { client });
    assert.equal(otherClient.skipped, true);
    assert.equal(otherClient.reason, 'not_essence_retention_client');

    const otherAgency = await notifyEssenceAiDemoBooked({
        ...demo,
        agencyId: 'efddb63d-a4c9-44d9-a204-baa052fd0fd8',
        clientSlug: ESSENCE_RETENTION_CLIENT_SLUG
    }, { client });
    assert.equal(otherAgency.skipped, true);
    assert.equal(otherAgency.reason, 'not_essence_retention_client');
});
