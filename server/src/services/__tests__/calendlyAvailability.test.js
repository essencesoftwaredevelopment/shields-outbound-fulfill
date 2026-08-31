import assert from 'node:assert/strict';
import test from 'node:test';
import { ESSENCE_AI_DEMO_EVENT_TYPE_ID } from '../discoveryCallResend.js';
import {
    ESSENCE_AI_DEMO_EVENT_TYPE_URI,
    listEventTypeAvailableTimes,
    normalizeAvailableTimes,
    resolveAvailabilityWindow,
    toEventTypeUri
} from '../calendlyAvailability.js';

const DEMO_URI = `https://api.calendly.com/event_types/${ESSENCE_AI_DEMO_EVENT_TYPE_ID}`;

test('toEventTypeUri: defaults to Essence AI Demo', () => {
    assert.equal(toEventTypeUri(), DEMO_URI);
    assert.equal(toEventTypeUri(''), DEMO_URI);
    assert.equal(ESSENCE_AI_DEMO_EVENT_TYPE_URI, DEMO_URI);
});

test('toEventTypeUri: accepts UUID or URI', () => {
    assert.equal(toEventTypeUri(ESSENCE_AI_DEMO_EVENT_TYPE_ID), DEMO_URI);
    assert.equal(toEventTypeUri(`${DEMO_URI}/`), DEMO_URI);
});

test('toEventTypeUri: rejects unknown shapes', () => {
    assert.throws(() => toEventTypeUri('essence-ai-demo'), /event type UUID or URI/);
});

test('resolveAvailabilityWindow: defaults to a 7-day window from now', () => {
    const now = new Date('2026-09-01T12:00:00.000Z');
    const window = resolveAvailabilityWindow({ now });
    assert.equal(window.startTime, '2026-09-01T12:00:00.000Z');
    assert.equal(window.endTime, '2026-09-08T12:00:00.000Z');
});

test('resolveAvailabilityWindow: rejects inverted or oversized ranges', () => {
    assert.throws(
        () => resolveAvailabilityWindow({
            startTime: '2026-09-08T12:00:00.000Z',
            endTime: '2026-09-01T12:00:00.000Z'
        }),
        /endTime must be after startTime/
    );
    assert.throws(
        () => resolveAvailabilityWindow({
            startTime: '2026-09-01T12:00:00.000Z',
            endTime: '2026-09-09T12:00:01.000Z'
        }),
        /cannot exceed 7 days/
    );
});

test('normalizeAvailableTimes: maps Calendly collection fields', () => {
    const times = normalizeAvailableTimes([
        {
            status: 'available',
            invitees_remaining: 1,
            start_time: '2026-09-02T14:00:00.000000Z',
            scheduling_url: 'https://calendly.com/essencesoftwaredevelopment/essence-ai-demo/2026-09-02T14:00:00Z'
        }
    ]);
    assert.deepEqual(times, [{
        startTime: '2026-09-02T14:00:00.000000Z',
        status: 'available',
        inviteesRemaining: 1,
        schedulingUrl: 'https://calendly.com/essencesoftwaredevelopment/essence-ai-demo/2026-09-02T14:00:00Z'
    }]);
});

test('listEventTypeAvailableTimes: calls Calendly with PAT and query params', async () => {
    const calls = [];
    const result = await listEventTypeAvailableTimes({
        startTime: '2026-09-01T00:00:00.000Z',
        endTime: '2026-09-07T00:00:00.000Z',
        pat: 'test-pat',
        request: async (url, options) => {
            calls.push({ url, options });
            return {
                collection: [{
                    status: 'available',
                    invitees_remaining: 1,
                    start_time: '2026-09-02T14:00:00.000000Z',
                    scheduling_url: 'https://calendly.com/x'
                }]
            };
        }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.pat, 'test-pat');
    const parsed = new URL(calls[0].url);
    assert.equal(parsed.pathname, '/event_type_available_times');
    assert.equal(parsed.searchParams.get('event_type'), DEMO_URI);
    assert.equal(parsed.searchParams.get('start_time'), '2026-09-01T00:00:00.000Z');
    assert.equal(parsed.searchParams.get('end_time'), '2026-09-07T00:00:00.000Z');
    assert.equal(result.times.length, 1);
    assert.equal(result.times[0].schedulingUrl, 'https://calendly.com/x');
});

test('listEventTypeAvailableTimes: 503 when PAT is missing', async () => {
    await assert.rejects(
        () => listEventTypeAvailableTimes({ pat: '', request: async () => ({ collection: [] }) }),
        (error) => error.statusCode === 503
    );
});
