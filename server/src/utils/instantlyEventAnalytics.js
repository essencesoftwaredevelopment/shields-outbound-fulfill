import {
    buildPositiveRepliesCoreSql
} from './positiveReplyAnalytics.js';

const TYPED_EVENT_TYPES = new Set([
    'email_sent',
    'lead_interested',
    'lead_meeting_booked'
]);

const ANALYTICS_CACHE_TTL_MS = 60_000;
const analyticsCache = new Map();
const analyticsInFlight = new Map();

const PERIOD_DAY_SPAN = {
    '7d': 6,
    '30d': 29,
    '90d': 89
};

function pruneAnalyticsCache() {
    if (analyticsCache.size <= 200) return;
    const now = Date.now();
    for (const [key, entry] of analyticsCache) {
        if (entry.expiresAt <= now) {
            analyticsCache.delete(key);
        }
    }
}

function buildAnalyticsCacheKey(agencyId, sqlClientId, period, eventType, scope = 'full') {
    return `${agencyId}:${sqlClientId}:${period}:${eventType}:${scope}`;
}

export function buildInstantlyEventPeriodFilterSql(eventFloorSql, tableAlias = 'cie') {
    return `${tableAlias}.client_id = $2
          AND ${tableAlias}.event_timestamp >= ${eventFloorSql}
          AND ${tableAlias}.agency_id = $1`;
}

export function buildTypedInstantlyEventPeriodFilterSql(eventFloorSql, eventType, tableAlias = 'cie') {
    if (!TYPED_EVENT_TYPES.has(eventType)) {
        throw new Error(`Unsupported typed analytics event_type: ${eventType}`);
    }

    return `${tableAlias}.agency_id = $1
          AND ${tableAlias}.client_id = $2
          AND ${tableAlias}.event_type = '${eventType}'
          AND ${tableAlias}.event_timestamp >= ${eventFloorSql}`;
}

export function buildInstantlyEventSummaryQuery(periodFilterSql, eventTypeFilterClause) {
    return `
        SELECT
            COUNT(*)::int AS total_events,
            COUNT(DISTINCT cie.contact_id)::int AS unique_contacts,
            COUNT(DISTINCT cie.campaign_id)::int AS unique_campaigns,
            COUNT(*) FILTER (
                WHERE LOWER(COALESCE(cie.event_type, '')) = 'email_sent'
            )::int AS emails_sent,
            COUNT(DISTINCT cie.contact_id) FILTER (
                WHERE LOWER(COALESCE(cie.event_type, '')) = 'email_sent'
            )::int AS contacts_emailed,
            COUNT(DISTINCT cie.contact_id) FILTER (
                WHERE LOWER(COALESCE(cie.event_type, '')) = 'lead_meeting_booked'
                  AND cie.contact_id IS NOT NULL
            )::int AS meetings_booked,
            COUNT(*) FILTER (
                WHERE LOWER(COALESCE(cie.event_type, '')) IN ('reply', 'replied')
            )::int AS reply_events,
            COUNT(*) FILTER (
                WHERE LOWER(COALESCE(cie.event_type, '')) LIKE '%bounce%'
            )::int AS bounce_events,
            MIN(cie.event_timestamp) AS first_event_at,
            MAX(cie.event_timestamp) AS last_event_at
        FROM contact_instantly_events cie
        WHERE ${periodFilterSql}${eventTypeFilterClause}
    `;
}

/**
 * Count unique contacts with a meeting booked in the period.
 * Multiple sources (Calendly + Instantly status/webhook/manual/reconcile) for the
 * same lead collapse to one booking, attributed to the earliest event timestamp.
 */
export function buildMeetingsBookedByBucketQuery(periodConfig) {
    const bucketUnit = periodConfig.bucketUnit === 'hour' ? 'hour' : 'day';

    const typedFilterSql = buildTypedInstantlyEventPeriodFilterSql(
        periodConfig.eventFloorSql,
        'lead_meeting_booked'
    );

    return `
        WITH first_meeting_per_contact AS (
            SELECT DISTINCT ON (cie.contact_id)
                cie.contact_id,
                cie.event_timestamp AS booked_at
            FROM contact_instantly_events cie
            WHERE ${typedFilterSql}
              AND cie.contact_id IS NOT NULL
            ORDER BY cie.contact_id, cie.event_timestamp ASC, cie.id ASC
        )
        SELECT
            TO_CHAR(DATE_TRUNC('${bucketUnit}', fmc.booked_at), 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
            COUNT(*)::int AS count
        FROM first_meeting_per_contact fmc
        GROUP BY 1
        ORDER BY 1 ASC
    `;
}

export function buildMeetingsBookedCoreSql(periodConfig) {
    const bucketUnit = periodConfig.bucketUnit === 'hour' ? 'hour' : 'day';
    const typedFilterSql = buildTypedInstantlyEventPeriodFilterSql(
        periodConfig.eventFloorSql,
        'lead_meeting_booked'
    );

    return `
        WITH first_meeting_per_contact AS (
            SELECT DISTINCT ON (cie.contact_id)
                cie.contact_id,
                cie.event_timestamp AS booked_at
            FROM contact_instantly_events cie
            WHERE ${typedFilterSql}
              AND cie.contact_id IS NOT NULL
            ORDER BY cie.contact_id, cie.event_timestamp ASC, cie.id ASC
        )
        SELECT
            (SELECT COUNT(*)::int FROM first_meeting_per_contact) AS meetings_booked,
            COALESCE((
                SELECT json_agg(row_to_json(b) ORDER BY b.bucket)
                FROM (
                    SELECT
                        TO_CHAR(DATE_TRUNC('${bucketUnit}', fmc.booked_at), 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
                        COUNT(*)::int AS count
                    FROM first_meeting_per_contact fmc
                    GROUP BY 1
                ) b
            ), '[]'::json) AS buckets
    `;
}

export function buildEmailsSentByBucketQuery(periodConfig) {
    const typedFilterSql = buildTypedInstantlyEventPeriodFilterSql(
        periodConfig.eventFloorSql,
        'email_sent'
    );
    const bucketTruncSql = periodConfig.bucketTruncSql;

    return `
        SELECT
            TO_CHAR(${bucketTruncSql}, 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
            COUNT(*)::int AS count
        FROM contact_instantly_events cie
        WHERE ${typedFilterSql}
        GROUP BY 1
        ORDER BY 1 ASC
    `;
}

export function buildEmailsSentCoreSql(periodConfig) {
    const typedFilterSql = buildTypedInstantlyEventPeriodFilterSql(
        periodConfig.eventFloorSql,
        'email_sent'
    );
    const bucketUnit = periodConfig.bucketUnit === 'hour' ? 'hour' : 'day';

    return `
        WITH sent AS MATERIALIZED (
            SELECT cie.contact_id, cie.event_timestamp
            FROM contact_instantly_events cie
            WHERE ${typedFilterSql}
        )
        SELECT
            (SELECT COUNT(*)::int FROM sent) AS emails_sent,
            (SELECT COUNT(*)::int FROM (
                SELECT 1 FROM sent WHERE contact_id IS NOT NULL GROUP BY contact_id
            ) s) AS contacts_emailed,
            COALESCE((
                SELECT json_agg(row_to_json(b) ORDER BY b.bucket)
                FROM (
                    SELECT
                        TO_CHAR(DATE_TRUNC('${bucketUnit}', sent.event_timestamp), 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
                        COUNT(*)::int AS count
                    FROM sent
                    GROUP BY 1
                ) b
            ), '[]'::json) AS buckets
    `;
}

export function buildInstantlyEventBucketCountsQuery(periodConfig, periodFilterSql, eventTypeFilterClause) {
    const bucketTruncSql = periodConfig.bucketTruncSql;

    return `
        SELECT
            TO_CHAR(${bucketTruncSql}, 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
            COUNT(*)::int AS count
        FROM contact_instantly_events cie
        WHERE ${periodFilterSql}${eventTypeFilterClause}
        GROUP BY 1
        ORDER BY 1 ASC
    `;
}

export function buildInstantlyEventTypesQuery(periodFilterSql, eventTypeFilterClause) {
    return `
        SELECT LOWER(COALESCE(cie.event_type, 'unknown')) AS event_type
        FROM contact_instantly_events cie
        WHERE ${periodFilterSql}${eventTypeFilterClause}
        GROUP BY 1
        ORDER BY 1 ASC
    `;
}

export function buildFollowUpStatsQuery(eventFloorSql) {
    return `
        SELECT COUNT(*)::int AS follow_up_sent
        FROM follow_up_sends fus
        WHERE fus.client_id = $1
          AND fus.status = 'sent'
          AND fus.updated_at >= ${eventFloorSql}
    `;
}

export function buildInstantlyRecentEventsQuery(eventFloorSql, eventTypeFilterClause) {
    const periodFilterSql = buildInstantlyEventPeriodFilterSql(eventFloorSql);

    return `
        SELECT
            cie.id::text AS id,
            LOWER(COALESCE(cie.event_type, 'unknown')) AS event_type,
            cie.reply_category,
            cie.lead_email,
            cie.contact_id::text AS contact_id,
            cie.email_account,
            cie.message_text,
            cie.reply_text_snippet,
            cie.event_timestamp,
            ic.name AS campaign_name
        FROM contact_instantly_events cie
        LEFT JOIN instantly_campaigns ic ON ic.id = cie.campaign_id
        WHERE ${periodFilterSql}${eventTypeFilterClause}
        ORDER BY cie.event_timestamp DESC NULLS LAST, cie.created_at DESC NULLS LAST, cie.id DESC
        LIMIT 25
    `;
}

function truncateToUtcHour(date) {
    const truncated = new Date(date);
    truncated.setUTCMinutes(0, 0, 0);
    return truncated;
}

function truncateToUtcDay(date) {
    const truncated = new Date(date);
    truncated.setUTCHours(0, 0, 0, 0);
    return truncated;
}

function formatBucketKey(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}:00:00Z`;
}

function formatBucketLabel(date, bucketUnit) {
    if (bucketUnit === 'hour') {
        return `${String(date.getUTCHours()).padStart(2, '0')}:00`;
    }

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${monthNames[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function generateBucketSeries(periodConfig, now = new Date()) {
    const { period, bucketUnit } = periodConfig;
    const buckets = [];

    if (bucketUnit === 'hour') {
        const end = truncateToUtcHour(now);
        const start = new Date(end);
        start.setUTCHours(start.getUTCHours() - 23);

        for (let cursor = new Date(start); cursor <= end; cursor.setUTCHours(cursor.getUTCHours() + 1)) {
            const bucketDate = new Date(cursor);
            buckets.push({
                bucket: formatBucketKey(bucketDate),
                label: formatBucketLabel(bucketDate, bucketUnit)
            });
        }

        return buckets;
    }

    const daySpan = PERIOD_DAY_SPAN[period] ?? 6;
    const end = truncateToUtcDay(now);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - daySpan);

    for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
        const bucketDate = new Date(cursor);
        buckets.push({
            bucket: formatBucketKey(bucketDate),
            label: formatBucketLabel(bucketDate, bucketUnit)
        });
    }

    return buckets;
}

export function mergeAnalyticsBuckets({
    periodConfig,
    eventBucketRows,
    emailsSentBucketRows,
    positiveReplyBucketRows,
    meetingsBookedBucketRows
}) {
    const eventCounts = new Map(
        (eventBucketRows || []).map((row) => [row.bucket, Number(row.count) || 0])
    );
    const emailsSentCounts = new Map(
        (emailsSentBucketRows || []).map((row) => [row.bucket, Number(row.count) || 0])
    );
    const positiveReplyCounts = new Map(
        (positiveReplyBucketRows || []).map((row) => [row.bucket, Number(row.count) || 0])
    );
    const meetingsBookedCounts = new Map(
        (meetingsBookedBucketRows || []).map((row) => [row.bucket, Number(row.count) || 0])
    );

    return generateBucketSeries(periodConfig).map(({ bucket, label }) => ({
        bucket,
        label,
        count: eventCounts.get(bucket) ?? 0,
        emails_sent: emailsSentCounts.get(bucket) ?? 0,
        positive_replies: positiveReplyCounts.get(bucket) ?? 0,
        meetings_booked: meetingsBookedCounts.get(bucket) ?? 0
    }));
}

function parseJsonAgg(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

async function withAnalyticsCache(cacheKey, skipCache, loader) {
    if (!skipCache) {
        const cached = analyticsCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.value;
        }

        const inFlight = analyticsInFlight.get(cacheKey);
        if (inFlight) {
            return inFlight;
        }
    }

    const loadPromise = (async () => {
        const value = await loader();
        if (!skipCache) {
            analyticsCache.set(cacheKey, {
                value,
                expiresAt: Date.now() + ANALYTICS_CACHE_TTL_MS
            });
            pruneAnalyticsCache();
        }
        return value;
    })();

    if (!skipCache) {
        analyticsInFlight.set(cacheKey, loadPromise);
        try {
            return await loadPromise;
        } finally {
            analyticsInFlight.delete(cacheKey);
        }
    }

    return loadPromise;
}

export async function loadInstantlyEventAnalyticsCore({
    pool,
    agencyId,
    sqlClientId,
    periodConfig,
    skipCache = false
}) {
    const cacheKey = buildAnalyticsCacheKey(
        agencyId,
        sqlClientId,
        periodConfig.period,
        'all',
        'core'
    );
    const lifecycleParams = [agencyId, sqlClientId];

    return withAnalyticsCache(cacheKey, skipCache, async () => {
        const [emailsResult, positiveResult, meetingsResult] = await Promise.all([
            pool.query(buildEmailsSentCoreSql(periodConfig), lifecycleParams),
            pool.query(
                buildPositiveRepliesCoreSql(periodConfig.eventFloorSql, periodConfig.bucketUnit),
                lifecycleParams
            ),
            pool.query(buildMeetingsBookedCoreSql(periodConfig), lifecycleParams)
        ]);

        const emailsRow = emailsResult.rows[0] || {};
        const positiveRow = positiveResult.rows[0] || {};
        const meetingsRow = meetingsResult.rows[0] || {};

        return {
            summary: {
                emails_sent: emailsRow.emails_sent ?? 0,
                contacts_emailed: emailsRow.contacts_emailed ?? 0,
                positive_replies: positiveRow.positive_replies ?? 0,
                meetings_booked: meetingsRow.meetings_booked ?? 0
            },
            byHour: mergeAnalyticsBuckets({
                periodConfig,
                eventBucketRows: [],
                emailsSentBucketRows: parseJsonAgg(emailsRow.buckets),
                positiveReplyBucketRows: parseJsonAgg(positiveRow.buckets),
                meetingsBookedBucketRows: parseJsonAgg(meetingsRow.buckets)
            })
        };
    });
}

export async function loadInstantlyEventAnalyticsDetails({
    pool,
    agencyId,
    sqlClientId,
    periodConfig,
    eventTypeFilter,
    skipCache = false
}) {
    const cacheKey = buildAnalyticsCacheKey(
        agencyId,
        sqlClientId,
        periodConfig.period,
        eventTypeFilter.normalized,
        'details'
    );
    const analyticsParams = [agencyId, sqlClientId, ...eventTypeFilter.params];
    const periodFilterSql = buildInstantlyEventPeriodFilterSql(periodConfig.eventFloorSql);

    return withAnalyticsCache(cacheKey, skipCache, async () => {
        const [
            summaryResult,
            bucketCountsResult,
            eventTypesResult,
            recentEventsResult,
            followUpStatsResult
        ] = await Promise.all([
            pool.query(
                buildInstantlyEventSummaryQuery(periodFilterSql, eventTypeFilter.clause),
                analyticsParams
            ),
            pool.query(
                buildInstantlyEventBucketCountsQuery(
                    periodConfig,
                    periodFilterSql,
                    eventTypeFilter.clause
                ),
                analyticsParams
            ),
            pool.query(
                buildInstantlyEventTypesQuery(periodFilterSql, eventTypeFilter.clause),
                analyticsParams
            ),
            pool.query(
                buildInstantlyRecentEventsQuery(periodConfig.eventFloorSql, eventTypeFilter.clause),
                analyticsParams
            ),
            pool.query(
                buildFollowUpStatsQuery(periodConfig.eventFloorSql),
                [sqlClientId]
            )
        ]);

        const summaryRow = summaryResult.rows[0] || {};
        const followUpStats = followUpStatsResult.rows[0] || {
            follow_up_sent: 0
        };

        return {
            summary: summaryRow,
            byHour: mergeAnalyticsBuckets({
                periodConfig,
                eventBucketRows: bucketCountsResult.rows,
                emailsSentBucketRows: [],
                positiveReplyBucketRows: [],
                meetingsBookedBucketRows: []
            }),
            eventTypeRows: eventTypesResult.rows,
            recentEvents: recentEventsResult.rows,
            followUpStats
        };
    });
}

export async function loadInstantlyEventAnalytics({
    pool,
    agencyId,
    sqlClientId,
    periodConfig,
    eventTypeFilter,
    skipCache = false
}) {
    const core = await loadInstantlyEventAnalyticsCore({
        pool,
        agencyId,
        sqlClientId,
        periodConfig,
        skipCache
    });
    const details = await loadInstantlyEventAnalyticsDetails({
        pool,
        agencyId,
        sqlClientId,
        periodConfig,
        eventTypeFilter,
        skipCache
    });

    return mergeCoreAndDetailsAnalytics(core, details);
}

export function mergeCoreAndDetailsAnalytics(core, details) {
    const detailsByBucket = new Map(
        (details?.byHour || []).map((row) => [row.bucket, row])
    );

    return {
        summary: {
            ...(details?.summary || {}),
            emails_sent: core?.summary?.emails_sent ?? details?.summary?.emails_sent ?? 0,
            contacts_emailed: core?.summary?.contacts_emailed ?? details?.summary?.contacts_emailed ?? 0,
            positive_replies: core?.summary?.positive_replies ?? details?.summary?.positive_replies ?? 0,
            meetings_booked: core?.summary?.meetings_booked ?? details?.summary?.meetings_booked ?? 0
        },
        byHour: (core?.byHour || details?.byHour || []).map((row) => ({
            ...row,
            count: detailsByBucket.get(row.bucket)?.count ?? row.count ?? 0
        })),
        eventTypeRows: details?.eventTypeRows || [],
        recentEvents: details?.recentEvents || [],
        followUpStats: details?.followUpStats || { follow_up_sent: 0 }
    };
}
