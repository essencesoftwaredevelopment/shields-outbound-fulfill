import assert from 'node:assert/strict';
import test from 'node:test';
import { ESSENCE_AI_DEMO_EVENT_TYPE_ID } from '../discoveryCallResend.js';
import {
    bookEventInvitee,
    collectQuestionAnswers,
    mapAnswersToEventQuestions,
    parseBookingBody,
    resolveLocationPayload
} from '../calendlyBooking.js';

const DEMO_URI = `https://api.calendly.com/event_types/${ESSENCE_AI_DEMO_EVENT_TYPE_ID}`;

const QUESTIONS = [
    { uuid: 'q-website', name: 'Website', type: 'string', position: 0, enabled: true, required: true },
    { uuid: 'q-notes', name: 'Please share anything that will help prepare for our meeting', type: 'text', position: 1, enabled: true, required: false }
];

test('parseBookingBody: requires startTime, name, and email', () => {
    assert.throws(() => parseBookingBody({ name: 'Ada', email: 'ada@example.com' }), /startTime is required/);
    assert.throws(() => parseBookingBody({ startTime: '2026-09-02T14:00:00Z', email: 'ada@example.com' }), /name is required/);
    assert.throws(() => parseBookingBody({ startTime: '2026-09-02T14:00:00Z', name: 'Ada' }), /valid email/);
});

test('parseBookingBody: accepts invitee object and nested name parts', () => {
    const parsed = parseBookingBody({
        startTime: '2026-09-02T14:00:00.000Z',
        invitee: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', timezone: 'Europe/London' },
        questionsAndAnswers: [{ question: 'Website', answer: 'https://analytical.engine' }]
    });
    assert.equal(parsed.name, 'Ada Lovelace');
    assert.equal(parsed.email, 'ada@example.com');
    assert.equal(parsed.timezone, 'Europe/London');
    assert.equal(parsed.answers[0].answer, 'https://analytical.engine');
});

test('collectQuestionAnswers: accepts array or keyed object', () => {
    assert.deepEqual(
        collectQuestionAnswers({ Website: 'https://acme.com', notes: 'Ready to see a demo' }).map((row) => row.question),
        ['Website', 'notes']
    );
    assert.equal(
        collectQuestionAnswers([{ question_uuid: 'q-website', answer: 'https://acme.com' }])[0].questionUuid,
        'q-website'
    );
});

test('mapAnswersToEventQuestions: matches by name, uuid, or position and enforces required', () => {
    const mapped = mapAnswersToEventQuestions(
        [{ question: 'website', answer: 'https://acme.com' }],
        QUESTIONS
    );
    assert.equal(mapped[0].question, 'Website');
    assert.equal(mapped[0].question_uuid, 'q-website');
    assert.equal(mapped[0].position, 0);

    assert.throws(
        () => mapAnswersToEventQuestions([{ question: 'notes', answer: 'hi' }], QUESTIONS),
        /Missing answers for required questions: Website/
    );
});

test('resolveLocationPayload: uses the event type location kind', () => {
    assert.deepEqual(
        resolveLocationPayload({ locations: [{ kind: 'google_conference' }] }),
        { kind: 'google_conference' }
    );
    assert.equal(resolveLocationPayload({ locations: [] }), null);
    assert.throws(
        () => resolveLocationPayload({ locations: [{ kind: 'physical' }] }),
        /location is required/
    );
});

test('bookEventInvitee: GET event type then POST /invitees with mapped questions', async () => {
    const calls = [];
    const result = await bookEventInvitee({
        pat: 'test-pat',
        body: {
            startTime: '2026-09-02T14:00:00.000Z',
            name: 'Ada Lovelace',
            email: 'ada@example.com',
            timezone: 'America/New_York',
            questionsAndAnswers: [
                { question: 'Website', answer: 'https://analytical.engine' },
                { question: 'please share', answer: 'Wanted to see the AI demo' }
            ]
        },
        request: async (url, options) => {
            calls.push({ url, ...options });
            if (String(url).includes('/event_types/')) {
                return {
                    resource: {
                        uri: DEMO_URI,
                        locations: [{ kind: 'google_conference' }],
                        custom_questions: QUESTIONS
                    }
                };
            }
            return {
                resource: {
                    uri: 'https://api.calendly.com/scheduled_events/EVT/invitees/INV',
                    event: 'https://api.calendly.com/scheduled_events/EVT',
                    name: 'Ada Lovelace',
                    email: 'ada@example.com',
                    status: 'active',
                    timezone: 'America/New_York',
                    cancel_url: 'https://calendly.com/cancellations/INV',
                    reschedule_url: 'https://calendly.com/reschedulings/INV',
                    questions_and_answers: [
                        { question: 'Website', answer: 'https://analytical.engine', position: 0 }
                    ]
                }
            };
        }
    });

    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/event_types\/30336f6d-1955-4c5f-ad3c-49f319bd61e3$/);
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, 'https://api.calendly.com/invitees');
    assert.deepEqual(calls[1].data.location, { kind: 'google_conference' });
    assert.equal(calls[1].data.event_type, DEMO_URI);
    assert.equal(calls[1].data.invitee.email, 'ada@example.com');
    assert.equal(calls[1].data.questions_and_answers[0].question_uuid, 'q-website');
    assert.equal(calls[1].data.questions_and_answers[1].question_uuid, 'q-notes');
    assert.equal(result.cancelUrl, 'https://calendly.com/cancellations/INV');
    assert.equal(result.startTime, '2026-09-02T14:00:00.000Z');
});

test('bookEventInvitee: 503 when PAT is missing', async () => {
    await assert.rejects(
        () => bookEventInvitee({ pat: '', body: { startTime: '2026-09-02T14:00:00Z', name: 'Ada', email: 'ada@example.com' } }),
        (error) => error.statusCode === 503
    );
});
