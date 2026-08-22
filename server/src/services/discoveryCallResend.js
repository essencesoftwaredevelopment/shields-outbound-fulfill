/**
 * Fires the Resend "Discovery Pre Call" automation when an ESSENCE AI Demo
 * Calendly invitee is created. Upserts the Resend contact first so
 * contact.first_name / contact.email resolve in the template.
 */

import { Resend } from 'resend';
import { env } from '../config/env.js';
import { normalizeDomain } from '../utils/domain.js';

export const DISCOVERY_CALL_BOOKED_EVENT = 'Discovery Call Booked';
export const ESSENCE_AI_DEMO_EVENT_TYPE_ID = '30336f6d-1955-4c5f-ad3c-49f319bd61e3';
export const DEFAULT_INVITER_NAME = 'Jacques';
export const DEFAULT_RESCHEDULE_LINK = 'https://calendly.com/essencesoftwaredevelopment/essence-ai-demo';

const ESSENCE_AI_DEMO_NAME_RE = /essence\s*ai\s*demo/i;

let resendClient = null;

export function getResendClient(apiKey = env.RESEND_API_KEY) {
    if (!apiKey) return null;
    if (!resendClient) {
        resendClient = new Resend(apiKey);
    }
    return resendClient;
}

export function resetResendClient() {
    resendClient = null;
}

function firstNonEmptyString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

export function isEssenceAiDemoEvent({ eventName, scheduledEvent, payload } = {}) {
    const name = firstNonEmptyString(
        eventName,
        scheduledEvent?.name,
        payload?.scheduled_event?.name,
        payload?.event_type?.name
    );
    if (name && ESSENCE_AI_DEMO_NAME_RE.test(name)) return true;

    const eventTypeUri = firstNonEmptyString(
        typeof scheduledEvent?.event_type === 'string' ? scheduledEvent.event_type : null,
        typeof payload?.scheduled_event?.event_type === 'string' ? payload.scheduled_event.event_type : null,
        typeof payload?.event_type === 'string' ? payload.event_type : null,
        payload?.event_type?.uri
    );
    return Boolean(eventTypeUri && eventTypeUri.includes(ESSENCE_AI_DEMO_EVENT_TYPE_ID));
}

export function splitPersonName({ firstName, lastName, fullName } = {}) {
    const explicitFirst = firstNonEmptyString(firstName);
    const explicitLast = firstNonEmptyString(lastName);
    if (explicitFirst) {
        return { firstName: explicitFirst, lastName: explicitLast };
    }

    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { firstName: null, lastName: null };
    if (parts.length === 1) return { firstName: parts[0], lastName: null };
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

export function answerForQuestion(questions, matcher) {
    if (!Array.isArray(questions)) return null;
    const needle = String(matcher || '').toLowerCase();
    const hit = questions.find((item) => String(item?.question || '').toLowerCase().includes(needle));
    return firstNonEmptyString(hit?.answer);
}

export function brandNameFromDomain(value) {
    const host = normalizeDomain(value);
    if (!host) return null;
    const sld = host.split('.')[0];
    if (!sld) return null;
    return sld
        .split(/[-_]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function ymdInZone(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDaysYmd(ymd, days) {
    const [year, month, day] = ymd.split('-').map(Number);
    const utc = new Date(Date.UTC(year, month - 1, day + days));
    const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(utc.getUTCDate()).padStart(2, '0');
    return `${utc.getUTCFullYear()}-${mm}-${dd}`;
}

function formatTimeInZone(date, timeZone) {
    return new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone
    }).format(date);
}

export function formatCallDate(iso, timeZone) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    const tz = timeZone || 'UTC';
    try {
        return new Intl.DateTimeFormat('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZone: tz,
            timeZoneName: 'short'
        }).format(date);
    } catch {
        return date.toISOString();
    }
}

export function formatCallDateRelative(iso, timeZone, now = new Date()) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    const tz = timeZone || 'UTC';
    let startYmd;
    let nowYmd;
    try {
        startYmd = ymdInZone(date, tz);
        nowYmd = ymdInZone(now, tz);
    } catch {
        return formatCallDate(iso, tz);
    }

    const time = formatTimeInZone(date, tz);
    if (startYmd === nowYmd) return `today at ${time}`;
    if (startYmd === addDaysYmd(nowYmd, 1)) return `tomorrow at ${time}`;

    const weekday = new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        timeZone: tz
    }).format(date);
    return `${weekday} at ${time}`;
}

export function extractMeetingJoinLink({ scheduledEvent, location } = {}) {
    const joinUrl = firstNonEmptyString(
        scheduledEvent?.location?.join_url,
        typeof scheduledEvent?.location === 'string' ? scheduledEvent.location : null,
        typeof location === 'string' && location.startsWith('http') ? location : null
    );
    return joinUrl;
}

export function buildDiscoveryCallBookedPayload({
    email,
    inviteeName,
    invitee,
    enrichedInvitee,
    payload,
    scheduledEvent,
    questionsAndAnswers,
    location,
    startTime,
    contact,
    now = new Date()
} = {}) {
    const source = enrichedInvitee || invitee || payload || {};
    const names = splitPersonName({
        firstName: source.first_name,
        lastName: source.last_name,
        fullName: inviteeName || source.name || contact?.full_name
    });
    const timezone = firstNonEmptyString(
        source.timezone,
        invitee?.timezone,
        payload?.timezone,
        scheduledEvent?.timezone
    ) || 'UTC';
    const website = answerForQuestion(questionsAndAnswers, 'website');
    const domain = firstNonEmptyString(
        normalizeDomain(website) || null,
        contact?.domain,
        email && email.includes('@') ? email.split('@').pop() : null
    );
    const inviterName = firstNonEmptyString(
        scheduledEvent?.event_memberships?.[0]?.user_name,
        payload?.scheduled_event?.event_memberships?.[0]?.user_name,
        DEFAULT_INVITER_NAME
    );
    const callDate = formatCallDate(startTime, timezone);
    const eventPayload = {
        first_name: names.firstName,
        call_date: callDate,
        call_date_relative: formatCallDateRelative(startTime, timezone, now),
        meeting_join_link: extractMeetingJoinLink({ scheduledEvent, location }),
        reschedule_link: firstNonEmptyString(
            source.reschedule_url,
            invitee?.reschedule_url,
            payload?.reschedule_url,
            DEFAULT_RESCHEDULE_LINK
        ),
        inviter_name: inviterName,
        brand_name: brandNameFromDomain(domain),
        domain,
        esp: contact?.uses_klaviyo === false ? null : 'Klaviyo'
    };

    return {
        email: firstNonEmptyString(email, source.email),
        firstName: names.firstName,
        lastName: names.lastName,
        eventPayload: Object.fromEntries(
            Object.entries(eventPayload).filter(([, value]) => value != null && value !== '')
        )
    };
}

export async function upsertResendContact({ email, firstName, lastName }, { client } = {}) {
    const resend = client || getResendClient();
    if (!resend) {
        return { skipped: true, reason: 'missing_api_key' };
    }

    const nameFields = {
        ...(firstName ? { firstName } : {}),
        ...(lastName ? { lastName } : {})
    };

    const { data: existing } = await resend.contacts.get({ email });
    if (existing?.id) {
        const { error } = await resend.contacts.update({ email, ...nameFields });
        if (error) {
            throw new Error(error.message || 'Failed to update Resend contact');
        }
        return { id: existing.id, created: false };
    }

    const { data, error } = await resend.contacts.create({ email, ...nameFields });
    if (!error && data?.id) {
        return { id: data.id, created: true };
    }

    if (error?.statusCode === 409) {
        const { data: raced, error: updateError } = await resend.contacts.update({
            email,
            ...nameFields
        });
        if (updateError) {
            throw new Error(updateError.message || 'Failed to update Resend contact');
        }
        return { id: raced?.id || null, created: false };
    }

    throw new Error(error?.message || 'Failed to create Resend contact');
}

export async function sendDiscoveryCallBookedEvent({ email, payload }, { client } = {}) {
    const resend = client || getResendClient();
    if (!resend) {
        return { skipped: true, reason: 'missing_api_key' };
    }

    const { data, error } = await resend.events.send({
        event: DISCOVERY_CALL_BOOKED_EVENT,
        email,
        payload
    });
    if (error) {
        throw new Error(error.message || 'Failed to send Resend event');
    }
    return data || { accepted: true };
}

export async function notifyEssenceAiDemoBooked(context = {}, { client } = {}) {
    if (context.eventType !== 'invitee.created') {
        return { skipped: true, reason: 'not_invitee_created' };
    }
    if (!isEssenceAiDemoEvent(context)) {
        return { skipped: true, reason: 'not_essence_ai_demo' };
    }

    const built = buildDiscoveryCallBookedPayload(context);
    if (!built.email) {
        return { skipped: true, reason: 'missing_email' };
    }
    if (!built.eventPayload.call_date) {
        return { skipped: true, reason: 'missing_call_date' };
    }
    if (!built.eventPayload.meeting_join_link) {
        return { skipped: true, reason: 'missing_meeting_join_link' };
    }

    const resend = client || getResendClient();
    if (!resend) {
        return { skipped: true, reason: 'missing_api_key' };
    }

    const contact = await upsertResendContact({
        email: built.email,
        firstName: built.firstName,
        lastName: built.lastName
    }, { client: resend });

    await sendDiscoveryCallBookedEvent({
        email: built.email,
        payload: built.eventPayload
    }, { client: resend });

    return {
        skipped: false,
        contact_id: contact.id,
        contact_created: contact.created,
        email: built.email
    };
}
