import {
    buildPositiveRepliesByBucketSql,
    buildPositiveRepliesCountSql
} from './positiveReplyAnalytics.js';

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

function buildAnalyticsCacheKey(agencyId, sqlClientId, period, eventType) {
    return `${agencyId}:${sqlClientId}:${period}:${eventType}`;
}

export function buildInstantlyEventPeriodFilterSql(eventFloorSql, tableAlias = 'cie') {
    return `${tableAlias}.client_id = $2
          AND ${tableAlias}.event_timestamp >= ${eventFloorSql}
          AND ${tableAlias}.agency_id = $1`;
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
            COUNT(*) FILTER (
                WHERE LOWER(COALESCE(cie.event_type, '')) = 'lead_meeting_booked'
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

export function buildMeetingsBookedByBucketQuery(periodConfig) {
    const periodFilterSql = buildInstantlyEventPeriodFilterSql(periodConfig.eventFloorSql);
    const bucketTruncSql = periodConfig.bucketTruncSql;

    return `
        SELECT
            TO_CHAR(${bucketTruncSql}, 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
            COUNT(*)::int AS count
        FROM contact_instantly_events cie
        WHERE ${periodFilterSql}
          AND LOWER(COALESCE(cie.event_type, '')) = 'lead_meeting_booked'
        GROUP BY 1
        ORDER BY 1 ASC
    `;
}

export function buildEmailsSentByBucketQuery(periodConfig) {
    const periodFilterSql = buildInstantlyEventPeriodFilterSql(periodConfig.eventFloorSql);
    const bucketTruncSql = periodConfig.bucketTruncSql;

    return `
        SELECT
            TO_CHAR(${bucketTruncSql}, 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
            COUNT(*)::int AS count
        FROM contact_instantly_events cie
        WHERE ${periodFilterSql}
          AND LOWER(COALESCE(cie.event_type, '')) = 'email_sent'
        GROUP BY 1
        ORDER BY 1 ASC
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

export async function loadInstantlyEventAnalytics({
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
        eventTypeFilter.normalized
    );

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

    const analyticsParams = [agencyId, sqlClientId, ...eventTypeFilter.params];
    const periodFilterSql = buildInstantlyEventPeriodFilterSql(periodConfig.eventFloorSql);
    const lifecycleParams = [agencyId, sqlClientId];

    const loadPromise = (async () => {
        const [
            summaryResult,
            bucketCountsResult,
            eventTypesResult,
            positiveRepliesResult,
            positiveRepliesByBucketResult,
            meetingsBookedByBucketResult,
            emailsSentByBucketResult,
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
                buildPositiveRepliesCountSql(periodConfig.eventFloorSql),
                lifecycleParams
            ),
            pool.query(
                buildPositiveRepliesByBucketSql(periodConfig.eventFloorSql, periodConfig.bucketUnit),
                lifecycleParams
            ),
            pool.query(
                buildMeetingsBookedByBucketQuery(periodConfig),
                lifecycleParams
            ),
            pool.query(
                buildEmailsSentByBucketQuery(periodConfig),
                lifecycleParams
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
        const positiveReplies = positiveRepliesResult.rows[0]?.positive_replies ?? 0;
        const followUpStats = followUpStatsResult.rows[0] || {
            follow_up_sent: 0
        };

        const value = {
            summary: {
                ...summaryRow,
                positive_replies: positiveReplies
            },
            byHour: mergeAnalyticsBuckets({
                periodConfig,
                eventBucketRows: bucketCountsResult.rows,
                emailsSentBucketRows: emailsSentByBucketResult.rows,
                positiveReplyBucketRows: positiveRepliesByBucketResult.rows,
                meetingsBookedBucketRows: meetingsBookedByBucketResult.rows
            }),
            eventTypeRows: eventTypesResult.rows,
            recentEvents: recentEventsResult.rows,
            followUpStats
        };

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
