import axios from 'axios';
import { env } from '../config/env.js';
import { splitPersonName } from './discoveryCallResend.js';
import {
    calendlyHttpError,
    toEventTypeUri
} from './calendlyAvailability.js';

const CALENDLY_API_BASE = 'https://api.calendly.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

function stringifyAnswer(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map((item) => String(item)).join('\n');
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    return String(value).trim();
}

export function collectQuestionAnswers(input) {
    if (!input) return [];
    if (Array.isArray(input)) {
        return input
            .map((item) => {
                if (!item || typeof item !== 'object') return null;
                const question = firstNonEmptyString(item.question, item.name, item.questionName);
                const questionUuid = firstNonEmptyString(item.questionUuid, item.question_uuid, item.uuid);
                const position = Number.isInteger(item.position) ? item.position : null;
                const answer = stringifyAnswer(item.answer ?? item.value);
                if (!answer && !question && !questionUuid) return null;
                return { question, questionUuid, position, answer };
            })
            .filter(Boolean);
    }
    if (typeof input !== 'object') return [];

    return Object.entries(input)
        .map(([question, answer]) => {
            const text = stringifyAnswer(answer);
            if (!text) return null;
            return { question: String(question).trim(), questionUuid: null, position: null, answer: text };
        })
        .filter(Boolean);
}

function questionKey(value) {
    return String(value || '').trim().toLowerCase();
}

function findCustomQuestion(customQuestions, answer) {
    if (!Array.isArray(customQuestions) || customQuestions.length === 0) return null;

    if (answer.questionUuid) {
        const byUuid = customQuestions.find((question) => question.uuid === answer.questionUuid);
        if (byUuid) return byUuid;
    }

    if (Number.isInteger(answer.position)) {
        const byPosition = customQuestions.find((question) => question.position === answer.position);
        if (byPosition) return byPosition;
    }

    const needle = questionKey(answer.question);
    if (!needle) return null;

    return customQuestions.find((question) => questionKey(question.name) === needle)
        || customQuestions.find((question) => questionKey(question.name).includes(needle))
        || customQuestions.find((question) => needle.includes(questionKey(question.name)));
}

export function mapAnswersToEventQuestions(answers, customQuestions = []) {
    const enabled = (Array.isArray(customQuestions) ? customQuestions : [])
        .filter((question) => question && question.enabled !== false);
    const mapped = [];
    const used = new Set();

    for (const answer of answers) {
        if (!answer?.answer) continue;
        const match = findCustomQuestion(enabled, answer);
        if (match) {
            used.add(match);
            const row = {
                question: match.name,
                answer: answer.answer,
                position: Number.isInteger(match.position) ? match.position : mapped.length
            };
            if (match.uuid) row.question_uuid = match.uuid;
            mapped.push(row);
            continue;
        }
        mapped.push({
            question: answer.question || `Question ${mapped.length + 1}`,
            answer: answer.answer,
            position: Number.isInteger(answer.position) ? answer.position : mapped.length,
            ...(answer.questionUuid ? { question_uuid: answer.questionUuid } : {})
        });
    }

    const missingRequired = enabled.filter((question) => question.required && !used.has(question));
    if (missingRequired.length) {
        throw calendlyHttpError(
            400,
            `Missing answers for required questions: ${missingRequired.map((question) => question.name).join(', ')}`
        );
    }

    return mapped.sort((a, b) => a.position - b.position);
}

export function parseBookingBody(body = {}) {
    const invitee = (body.invitee && typeof body.invitee === 'object') ? body.invitee : {};
    const firstName = firstNonEmptyString(body.firstName, body.first_name, invitee.first_name);
    const lastName = firstNonEmptyString(body.lastName, body.last_name, invitee.last_name);
    const names = splitPersonName({
        firstName,
        lastName,
        fullName: firstNonEmptyString(body.name, invitee.name)
    });
    const name = firstNonEmptyString(
        body.name,
        invitee.name,
        [names.firstName, names.lastName].filter(Boolean).join(' ')
    );
    const email = firstNonEmptyString(body.email, invitee.email);
    const timezone = firstNonEmptyString(body.timezone, invitee.timezone) || 'America/New_York';
    const startTimeRaw = firstNonEmptyString(body.startTime, body.start_time);
    const eventType = body.eventType || body.event_type || invitee.event_type || null;
    const questionsInput = body.questionsAndAnswers
        ?? body.questions_and_answers
        ?? body.answers
        ?? null;
    const locationKind = firstNonEmptyString(
        body.location?.kind,
        body.locationKind,
        body.location_kind
    );
    const locationValue = firstNonEmptyString(
        typeof body.location === 'string' ? body.location : null,
        body.location?.location
    );

    if (!startTimeRaw) {
        throw calendlyHttpError(400, 'startTime is required.');
    }
    const start = new Date(startTimeRaw);
    if (Number.isNaN(start.getTime())) {
        throw calendlyHttpError(400, 'startTime must be a valid ISO 8601 timestamp.');
    }
    if (!name) {
        throw calendlyHttpError(400, 'name is required.');
    }
    if (!email || !EMAIL_RE.test(email)) {
        throw calendlyHttpError(400, 'A valid email is required.');
    }

    return {
        eventType,
        startTime: start.toISOString(),
        name,
        firstName: names.firstName,
        lastName: names.lastName,
        email,
        timezone,
        locationKind,
        locationValue,
        answers: collectQuestionAnswers(questionsInput)
    };
}

export function resolveLocationPayload(eventTypeResource, { locationKind, locationValue } = {}) {
    const configured = Array.isArray(eventTypeResource?.locations) ? eventTypeResource.locations : [];
    const kind = locationKind
        || (configured.length === 1 ? configured[0]?.kind : null)
        || (configured.find((item) => item?.kind === 'google_conference')?.kind)
        || configured[0]?.kind
        || null;
    if (!kind) return null;

    const location = { kind };
    const needsInviteeInput = kind === 'ask_invitee' || kind === 'outbound_call' || kind === 'physical';
    if (needsInviteeInput) {
        if (!locationValue) {
            throw calendlyHttpError(400, `location is required for location kind "${kind}".`);
        }
        location.location = locationValue;
    }
    return location;
}

function eventTypeUuidFromUri(uri) {
    const parts = String(uri || '').replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || null;
}

async function defaultCalendlyRequest(url, { method = 'GET', pat, data, timeout = 15000 } = {}) {
    const response = await axios({
        method,
        url,
        data,
        headers: {
            Authorization: `Bearer ${pat}`,
            'Content-Type': 'application/json'
        },
        timeout
    });
    return response.data;
}

function wrapCalendlyError(error) {
    if (error?.statusCode) throw error;
    const status = Number(error?.response?.status) || 502;
    const calendlyMessage = error?.response?.data?.message
        || error?.response?.data?.title
        || error?.message
        || 'Calendly booking request failed.';
    throw calendlyHttpError(
        status === 401 ? 502 : status,
        calendlyMessage,
        error?.response?.data?.details
    );
}

export function normalizeInviteeBooking(resource, { startTime, eventType } = {}) {
    const invitee = resource || {};
    return {
        uri: invitee.uri || null,
        event: invitee.event || null,
        eventType,
        startTime,
        status: invitee.status || 'active',
        name: invitee.name || null,
        email: invitee.email || null,
        timezone: invitee.timezone || null,
        cancelUrl: invitee.cancel_url || null,
        rescheduleUrl: invitee.reschedule_url || null,
        questionsAndAnswers: Array.isArray(invitee.questions_and_answers)
            ? invitee.questions_and_answers
            : []
    };
}

export async function bookEventInvitee({
    body,
    pat = env.CALENDLY_PAT,
    request = defaultCalendlyRequest
} = {}) {
    if (!pat) {
        throw calendlyHttpError(503, 'Calendly API is not configured.');
    }

    const parsed = parseBookingBody(body);
    const eventTypeUri = toEventTypeUri(parsed.eventType);
    const eventTypeUuid = eventTypeUuidFromUri(eventTypeUri);

    let eventTypeResource = null;
    try {
        const data = await request(`${CALENDLY_API_BASE}/event_types/${eventTypeUuid}`, { method: 'GET', pat });
        eventTypeResource = data?.resource || data || null;
    } catch (error) {
        wrapCalendlyError(error);
    }

    const questionsAndAnswers = mapAnswersToEventQuestions(
        parsed.answers,
        eventTypeResource?.custom_questions
    );
    const location = resolveLocationPayload(eventTypeResource, parsed);

    const payload = {
        event_type: eventTypeUri,
        start_time: parsed.startTime,
        invitee: {
            name: parsed.name,
            email: parsed.email,
            timezone: parsed.timezone,
            ...(parsed.firstName ? { first_name: parsed.firstName } : {}),
            ...(parsed.lastName ? { last_name: parsed.lastName } : {})
        },
        ...(location ? { location } : {}),
        ...(questionsAndAnswers.length ? { questions_and_answers: questionsAndAnswers } : {})
    };

    try {
        const data = await request(`${CALENDLY_API_BASE}/invitees`, {
            method: 'POST',
            pat,
            data: payload
        });
        return normalizeInviteeBooking(data?.resource || data, {
            startTime: parsed.startTime,
            eventType: eventTypeUri
        });
    } catch (error) {
        wrapCalendlyError(error);
    }
}
