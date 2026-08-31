import axios from 'axios';
import { env } from '../config/env.js';
import { ESSENCE_AI_DEMO_EVENT_TYPE_ID } from './discoveryCallResend.js';

const CALENDLY_API_BASE = 'https://api.calendly.com';
const EVENT_TYPE_URI_PREFIX = `${CALENDLY_API_BASE}/event_types/`;
const MAX_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

export const ESSENCE_AI_DEMO_EVENT_TYPE_URI = `${EVENT_TYPE_URI_PREFIX}${ESSENCE_AI_DEMO_EVENT_TYPE_ID}`;

export function calendlyHttpError(statusCode, message, details) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (details !== undefined) error.details = details;
    return error;
}

function httpError(statusCode, message, details) {
    return calendlyHttpError(statusCode, message, details);
}

export function toEventTypeUri(eventType) {
    const raw = String(eventType || '').trim();
    if (!raw) return ESSENCE_AI_DEMO_EVENT_TYPE_URI;
    if (raw.startsWith('https://api.calendly.com/event_types/')) return raw.replace(/\/+$/, '');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
        return `${EVENT_TYPE_URI_PREFIX}${raw}`;
    }
    throw httpError(400, 'eventType must be a Calendly event type UUID or URI.');
}

function parseIsoDate(value, field) {
    if (value == null || value === '') return null;
    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.getTime())) {
        throw httpError(400, `${field} must be a valid ISO 8601 timestamp.`);
    }
    return parsed;
}

/**
 * Calendly requires start_time + end_time and a range of at most 7 days.
 * Defaults to now → now+7d when either bound is omitted.
 */
export function resolveAvailabilityWindow({ startTime, endTime, now = new Date() } = {}) {
    const start = parseIsoDate(startTime, 'startTime') || now;
    const end = parseIsoDate(endTime, 'endTime') || new Date(start.getTime() + MAX_RANGE_MS);

    if (end.getTime() <= start.getTime()) {
        throw httpError(400, 'endTime must be after startTime.');
    }
    if (end.getTime() - start.getTime() > MAX_RANGE_MS) {
        throw httpError(400, 'Calendly availability windows cannot exceed 7 days.');
    }

    return {
        startTime: start.toISOString(),
        endTime: end.toISOString()
    };
}

export function normalizeAvailableTimes(collection) {
    if (!Array.isArray(collection)) return [];
    return collection.map((slot) => ({
        startTime: slot?.start_time || null,
        status: slot?.status || 'available',
        inviteesRemaining: Number.isFinite(slot?.invitees_remaining) ? slot.invitees_remaining : null,
        schedulingUrl: slot?.scheduling_url || null
    }));
}

async function defaultCalendlyGet(url, { pat, timeout = 15000 } = {}) {
    const response = await axios.get(url, {
        headers: {
            Authorization: `Bearer ${pat}`,
            'Content-Type': 'application/json'
        },
        timeout
    });
    return response.data;
}

export async function listEventTypeAvailableTimes({
    eventType,
    startTime,
    endTime,
    pat = env.CALENDLY_PAT,
    now,
    request = defaultCalendlyGet
} = {}) {
    if (!pat) {
        throw httpError(503, 'Calendly API is not configured.');
    }

    const eventTypeUri = toEventTypeUri(eventType);
    const window = resolveAvailabilityWindow({ startTime, endTime, now });
    const url = new URL(`${CALENDLY_API_BASE}/event_type_available_times`);
    url.searchParams.set('event_type', eventTypeUri);
    url.searchParams.set('start_time', window.startTime);
    url.searchParams.set('end_time', window.endTime);

    try {
        const data = await request(url.toString(), { pat });
        return {
            eventType: eventTypeUri,
            startTime: window.startTime,
            endTime: window.endTime,
            times: normalizeAvailableTimes(data?.collection)
        };
    } catch (error) {
        if (error?.statusCode) throw error;
        const status = Number(error?.response?.status) || 502;
        const calendlyMessage = error?.response?.data?.message
            || error?.response?.data?.title
            || error?.message
            || 'Calendly availability request failed.';
        throw httpError(status === 401 ? 502 : status, calendlyMessage);
    }
}
