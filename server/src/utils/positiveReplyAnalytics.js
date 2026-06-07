/**
 * Analytics rules for "positive replies" (qualified interested leads).
 *
 * - Count unique contacts with lead_interested inside the selected window.
 * - Contact qualifies if their latest lifecycle event across full history is a qualifying progression.
 * - Qualifying progressions: interested, meeting booked/completed, closed won, autoresponder reply, warm follow-up.
 * - Disqualifiers: lead_not_interested, lead_neutral, lead_wrong_person, bad fit.
 * - lead_out_of_office never disqualifies and never counts without lead_interested in-window.
 */

export const INTERESTED_EVENT_TYPE = 'lead_interested';

export const QUALIFYING_EVENT_TYPES = new Set([
    'lead_interested',
    'lead_meeting_booked',
    'lead_meeting_completed',
    'lead_closed',
    'interested_reply_sent'
]);

export const DISQUALIFYING_EVENT_TYPES = new Set([
    'lead_not_interested',
    'lead_neutral',
    'lead_wrong_person',
    'bad fit',
    'bad_fit'
]);

export const WARM_FOLLOW_UP_EVENT_SOURCE = 'server_follow_up';

export function normalizeLifecycleEventType(eventType) {
    return String(eventType || '').trim().toLowerCase();
}

export function getLifecycleStateDelta(eventType, source = null) {
    const normalized = normalizeLifecycleEventType(eventType);
    const normalizedSource = String(source || '').trim().toLowerCase();

    if (QUALIFYING_EVENT_TYPES.has(normalized)) {
        return 1;
    }
    if (
        normalized === 'email_sent'
        && normalizedSource === WARM_FOLLOW_UP_EVENT_SOURCE
    ) {
        return 1;
    }
    if (DISQUALIFYING_EVENT_TYPES.has(normalized) || normalized.replace(/_/g, ' ') === 'bad fit') {
        return -1;
    }
    return 0;
}

function toTimestampMs(value) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
}

function compareLifecycleEvents(left, right) {
    const leftTs = toTimestampMs(left.event_timestamp);
    const rightTs = toTimestampMs(right.event_timestamp);
    if (leftTs !== rightTs) {
        return (leftTs ?? 0) - (rightTs ?? 0);
    }
    return String(left.id ?? '').localeCompare(String(right.id ?? ''));
}

/**
 * Pure resolver used by tests and documentation of the SQL lifecycle rules.
 */
export function countQualifiedInterestedContacts(events, { periodStart, periodEnd = new Date().toISOString() } = {}) {
    const periodStartMs = toTimestampMs(periodStart);
    const periodEndMs = toTimestampMs(periodEnd);
    if (periodStartMs === null || periodEndMs === null) {
        return 0;
    }

    const eventsByContact = new Map();
    for (const event of events || []) {
        if (event?.contact_id === null || event?.contact_id === undefined) continue;
        const contactId = String(event.contact_id);
        if (!eventsByContact.has(contactId)) {
            eventsByContact.set(contactId, []);
        }
        eventsByContact.get(contactId).push(event);
    }

    let qualifiedCount = 0;
    for (const contactEvents of eventsByContact.values()) {
        const hasInterestedInWindow = contactEvents.some((event) => {
            const eventTs = toTimestampMs(event.event_timestamp);
            return normalizeLifecycleEventType(event.event_type) === INTERESTED_EVENT_TYPE
                && eventTs !== null
                && eventTs >= periodStartMs
                && eventTs <= periodEndMs;
        });
        if (!hasInterestedInWindow) {
            continue;
        }

        const lifecycleEvents = contactEvents
            .map((event) => ({
                ...event,
                lifecycleDelta: getLifecycleStateDelta(event.event_type, event.source)
            }))
            .filter((event) => event.lifecycleDelta !== 0)
            .sort(compareLifecycleEvents);

        if (lifecycleEvents.length === 0) {
            continue;
        }

        const finalLifecycleEvent = lifecycleEvents[lifecycleEvents.length - 1];
        if (finalLifecycleEvent.lifecycleDelta === 1) {
            qualifiedCount += 1;
        }
    }

    return qualifiedCount;
}

export function buildPositiveRepliesLifecycleCtesSql(periodFloorSql) {
    const qualifyingEventTypesSql = Array.from(QUALIFYING_EVENT_TYPES)
        .map((eventType) => `'${eventType}'`)
        .join(',\n                        ');

    return `
        period_interested_contacts AS (
            SELECT DISTINCT ON (cie.contact_id)
                cie.contact_id,
                cie.event_timestamp AS interested_at
            FROM contact_instantly_events cie
            WHERE cie.client_id = $2
              AND LOWER(TRIM(COALESCE(cie.event_type, ''))) = '${INTERESTED_EVENT_TYPE}'
              AND cie.event_timestamp >= ${periodFloorSql}
              AND cie.agency_id = $1
              AND cie.contact_id IS NOT NULL
            ORDER BY cie.contact_id, cie.event_timestamp ASC, cie.id ASC
        ),
        lifecycle_events AS (
            SELECT
                cie.contact_id,
                cie.event_timestamp,
                cie.id,
                CASE
                    WHEN LOWER(TRIM(COALESCE(cie.event_type, ''))) IN (
                        ${qualifyingEventTypesSql}
                    ) THEN 1
                    WHEN LOWER(TRIM(COALESCE(cie.event_type, ''))) = 'email_sent'
                         AND LOWER(TRIM(COALESCE(cie.source, ''))) = '${WARM_FOLLOW_UP_EVENT_SOURCE}'
                    THEN 1
                    WHEN LOWER(TRIM(COALESCE(cie.event_type, ''))) IN (
                        'lead_not_interested',
                        'lead_neutral',
                        'lead_wrong_person',
                        'bad fit',
                        'bad_fit'
                    )
                    OR LOWER(REPLACE(TRIM(COALESCE(cie.event_type, '')), '_', ' ')) = 'bad fit'
                    THEN -1
                    ELSE NULL
                END AS lifecycle_state
            FROM contact_instantly_events cie
            WHERE cie.client_id = $2
              AND cie.agency_id = $1
              AND cie.contact_id IN (SELECT contact_id FROM period_interested_contacts)
        ),
        last_lifecycle AS (
            SELECT DISTINCT ON (contact_id)
                contact_id,
                lifecycle_state
            FROM lifecycle_events
            WHERE lifecycle_state IS NOT NULL
            ORDER BY contact_id, event_timestamp DESC NULLS LAST, id DESC
        ),
        qualified_contacts AS (
            SELECT
                pic.contact_id,
                pic.interested_at
            FROM period_interested_contacts pic
            INNER JOIN last_lifecycle ll ON ll.contact_id = pic.contact_id
            WHERE ll.lifecycle_state = 1
        )`;
}

export function buildPositiveRepliesCountSql(periodFloorSql) {
    return `
        WITH ${buildPositiveRepliesLifecycleCtesSql(periodFloorSql)}
        SELECT COUNT(*)::int AS positive_replies
        FROM qualified_contacts
    `;
}

export function buildPositiveRepliesByBucketSql(periodFloorSql, bucketUnit) {
    return `
        WITH ${buildPositiveRepliesLifecycleCtesSql(periodFloorSql)}
        SELECT
            TO_CHAR(DATE_TRUNC('${bucketUnit}', qc.interested_at), 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
            COUNT(*)::int AS count
        FROM qualified_contacts qc
        GROUP BY 1
    `;
}
