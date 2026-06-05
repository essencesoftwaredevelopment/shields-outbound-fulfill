import { buildPositiveRepliesLifecycleCtesSql } from './positiveReplyAnalytics.js';

const ANALYTICS_CACHE_TTL_MS = 60_000;
const analyticsCache = new Map();
const analyticsInFlight = new Map();

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

export function buildInstantlyEventAnalyticsQuery({
    periodConfig,
    eventTypeFilterClause
}) {
    const {
        eventFloorSql,
        bucketStartSql,
        bucketEndSql,
        bucketUnit,
        bucketLabelSql,
        bucketTruncSql
    } = periodConfig;
    const bucketTruncForFiltered = bucketTruncSql.replace(/cie\./g, 'fe.');

    return `
        WITH period_events AS (
            SELECT
                cie.id,
                cie.contact_id,
                cie.campaign_id,
                cie.event_type,
                cie.event_timestamp
            FROM contact_instantly_events cie
            WHERE cie.agency_id = $1
              AND cie.client_id = $2
              AND cie.event_timestamp >= ${eventFloorSql}
        ),
        filtered_events AS (
            SELECT pe.*
            FROM period_events pe
            WHERE 1 = 1${eventTypeFilterClause}
        ),
        ${buildPositiveRepliesLifecycleCtesSql(eventFloorSql)},
        positive_replies_by_bucket AS (
            SELECT
                TO_CHAR(DATE_TRUNC('${bucketUnit}', qc.interested_at), 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
                COUNT(*)::int AS count
            FROM qualified_contacts qc
            GROUP BY 1
        ),
        summary AS (
            SELECT
                COUNT(*)::int AS total_events,
                COUNT(DISTINCT fe.contact_id)::int AS unique_contacts,
                COUNT(DISTINCT fe.campaign_id)::int AS unique_campaigns,
                COUNT(*) FILTER (
                    WHERE LOWER(COALESCE(fe.event_type, '')) = 'email_sent'
                )::int AS emails_sent,
                COUNT(*) FILTER (
                    WHERE LOWER(COALESCE(fe.event_type, '')) = 'lead_meeting_booked'
                )::int AS meetings_booked,
                COUNT(*) FILTER (
                    WHERE LOWER(COALESCE(fe.event_type, '')) IN ('reply', 'replied')
                )::int AS reply_events,
                COUNT(*) FILTER (
                    WHERE LOWER(COALESCE(fe.event_type, '')) LIKE '%bounce%'
                )::int AS bounce_events,
                MIN(fe.event_timestamp) AS first_event_at,
                MAX(fe.event_timestamp) AS last_event_at,
                (SELECT COUNT(*)::int FROM qualified_contacts) AS positive_replies
            FROM filtered_events fe
        ),
        hourly_buckets AS (
            SELECT
                TO_CHAR(hours.bucket, 'YYYY-MM-DD"T"HH24:00:00"Z"') AS bucket,
                ${bucketLabelSql} AS label,
                COALESCE(counts.count, 0)::int AS count,
                COALESCE(prb.count, 0)::int AS positive_replies
            FROM generate_series(
                ${bucketStartSql},
                ${bucketEndSql},
                INTERVAL '1 ${bucketUnit}'
            ) AS hours(bucket)
            LEFT JOIN (
                SELECT
                    ${bucketTruncForFiltered} AS bucket,
                    COUNT(*)::int AS count
                FROM filtered_events fe
                GROUP BY 1
            ) counts ON counts.bucket = hours.bucket
            LEFT JOIN positive_replies_by_bucket prb
                ON prb.bucket = TO_CHAR(hours.bucket, 'YYYY-MM-DD"T"HH24:00:00"Z"')
            ORDER BY hours.bucket ASC
        ),
        event_types AS (
            SELECT DISTINCT LOWER(COALESCE(pe.event_type, 'unknown')) AS event_type
            FROM period_events pe
        )
        SELECT
            (SELECT to_jsonb(s) FROM summary s) AS summary,
            (SELECT COALESCE(json_agg(to_jsonb(hb) ORDER BY hb.bucket ASC), '[]'::json) FROM hourly_buckets hb) AS by_hour,
            (SELECT COALESCE(json_agg(to_jsonb(et) ORDER BY et.event_type ASC), '[]'::json) FROM event_types et) AS event_types
    `;
}

export function buildInstantlyRecentEventsQuery(eventFloorSql, eventTypeFilterClause) {
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
        WHERE cie.agency_id = $1
          AND cie.client_id = $2
          AND cie.event_timestamp >= ${eventFloorSql}${eventTypeFilterClause}
        ORDER BY cie.event_timestamp DESC NULLS LAST, cie.created_at DESC NULLS LAST, cie.id DESC
        LIMIT 25
    `;
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
    const eventTypeFilterClause = eventTypeFilter.clause.replace(/\bcie\./g, 'pe.');

    const loadPromise = (async () => {
        const [bundleResult, recentEventsResult, followUpStatsResult] = await Promise.all([
            pool.query(
                buildInstantlyEventAnalyticsQuery({
                    periodConfig,
                    eventTypeFilterClause
                }),
                analyticsParams
            ),
            pool.query(
                buildInstantlyRecentEventsQuery(periodConfig.eventFloorSql, eventTypeFilter.clause),
                analyticsParams
            ),
            pool.query(
                `SELECT
                    COUNT(*) FILTER (
                        WHERE fus.sent_for_date = CURRENT_DATE
                    )::int AS follow_up_sent_today,
                    COUNT(*) FILTER (
                        WHERE fus.sent_for_date = CURRENT_DATE - INTERVAL '1 day'
                    )::int AS follow_up_sent_yesterday,
                    COUNT(*) FILTER (
                        WHERE fus.sent_for_date >= CURRENT_DATE - INTERVAL '6 days'
                    )::int AS follow_up_sent_7d
                FROM follow_up_sends fus
                WHERE fus.client_id = $1
                  AND fus.status = 'sent'`,
                [sqlClientId]
            )
        ]);

        const bundleRow = bundleResult.rows[0] || {};
        const summary = bundleRow.summary || {};
        const byHour = Array.isArray(bundleRow.by_hour) ? bundleRow.by_hour : [];
        const eventTypeRows = Array.isArray(bundleRow.event_types) ? bundleRow.event_types : [];
        const followUpStats = followUpStatsResult.rows[0] || {
            follow_up_sent_today: 0,
            follow_up_sent_yesterday: 0,
            follow_up_sent_7d: 0
        };

        const value = {
            summary,
            byHour,
            eventTypeRows,
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
