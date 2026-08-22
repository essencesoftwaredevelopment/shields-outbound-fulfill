import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildFollowUpStatsQuery,
    buildInstantlyEventBucketCountsQuery,
    buildInstantlyEventPeriodFilterSql,
    buildTypedInstantlyEventPeriodFilterSql,
    buildInstantlyEventSummaryQuery,
    buildInstantlyEventTypesQuery,
    buildInstantlyRecentEventsQuery,
    buildEmailsSentByBucketQuery,
    buildEmailsSentCoreSql,
    buildMeetingsBookedByBucketQuery,
    generateBucketSeries,
    mergeAnalyticsBuckets,
    mergeCoreAndDetailsAnalytics
} from '../instantlyEventAnalytics.js';

const PERIOD_CONFIG_7D = {
    period: '7d',
    bucketUnit: 'day',
    eventFloorSql: `NOW() - INTERVAL '7 days'`,
    bucketTruncSql: `DATE_TRUNC('day', cie.event_timestamp)`
};

const PERIOD_CONFIG_24H = {
    period: '24h',
    bucketUnit: 'hour',
    eventFloorSql: `NOW() - INTERVAL '24 hours'`,
    bucketTruncSql: `DATE_TRUNC('hour', cie.event_timestamp)`
};

const PERIOD_FILTER = buildInstantlyEventPeriodFilterSql(PERIOD_CONFIG_7D.eventFloorSql);

test('period filter leads with client_id for index-friendly scans', () => {
    assert.match(PERIOD_FILTER, /^cie\.client_id = \$2/);
    assert.match(PERIOD_FILTER, /cie\.event_timestamp >= NOW\(\) - INTERVAL '7 days'/);
    assert.match(PERIOD_FILTER, /cie\.agency_id = \$1/);
});

test('summary query scans the base table directly without analytics CTE bundle', () => {
    const sql = buildInstantlyEventSummaryQuery(PERIOD_FILTER, '');

    assert.match(sql, /FROM contact_instantly_events cie/);
    assert.doesNotMatch(sql, /WITH period_events AS/);
    assert.doesNotMatch(sql, /filtered_events/);
    assert.doesNotMatch(sql, /InitPlan/);
    assert.match(sql, /COUNT\(DISTINCT cie\.contact_id\)/);
    assert.match(sql, /COUNT\(DISTINCT cie\.contact_id\) FILTER \(\s*WHERE LOWER\(COALESCE\(cie\.event_type, ''\)\) = 'email_sent'\s*\)::int AS contacts_emailed/);
    assert.match(
        sql,
        /COUNT\(DISTINCT cie\.contact_id\) FILTER \(\s*WHERE LOWER\(COALESCE\(cie\.event_type, ''\)\) = 'lead_meeting_booked'\s+AND cie\.contact_id IS NOT NULL\s*\)::int AS meetings_booked/
    );
});

test('bucket and event-type queries use direct grouped scans', () => {
    const bucketSql = buildInstantlyEventBucketCountsQuery(PERIOD_CONFIG_7D, PERIOD_FILTER, '');
    const eventTypeSql = buildInstantlyEventTypesQuery(PERIOD_FILTER, '');

    assert.doesNotMatch(bucketSql, /WITH period_events AS/);
    assert.match(bucketSql, /GROUP BY 1/);
    assert.doesNotMatch(eventTypeSql, /SELECT DISTINCT/);
    assert.match(eventTypeSql, /GROUP BY 1/);
});

test('typed period filter leads with agency_id, client_id, then event_type', () => {
    const sql = buildTypedInstantlyEventPeriodFilterSql(PERIOD_CONFIG_7D.eventFloorSql, 'email_sent');

    assert.match(sql, /^cie\.agency_id = \$1/);
    assert.match(sql, /cie\.client_id = \$2/);
    assert.match(sql, /cie\.event_type = 'email_sent'/);
    assert.match(sql, /cie\.event_timestamp >= NOW\(\) - INTERVAL '7 days'/);
    assert.doesNotMatch(sql, /LOWER\(/);
});

test('meetings booked bucket query counts unique contacts by earliest booking', () => {
    const sql = buildMeetingsBookedByBucketQuery(PERIOD_CONFIG_7D);

    assert.match(sql, /WITH first_meeting_per_contact AS/);
    assert.match(sql, /SELECT DISTINCT ON \(cie\.contact_id\)/);
    assert.match(sql, /cie\.agency_id = \$1/);
    assert.match(sql, /event_type = 'lead_meeting_booked'/);
    assert.doesNotMatch(sql, /LOWER\(COALESCE\(cie\.event_type/);
    assert.match(sql, /cie\.contact_id IS NOT NULL/);
    assert.match(sql, /ORDER BY cie\.contact_id, cie\.event_timestamp ASC, cie\.id ASC/);
    assert.match(sql, /DATE_TRUNC\('day', fmc\.booked_at\)/);
    assert.match(sql, /GROUP BY 1/);
});

test('meetings booked bucket query uses hour truncation for 24h period', () => {
    const sql = buildMeetingsBookedByBucketQuery(PERIOD_CONFIG_24H);

    assert.match(sql, /DATE_TRUNC\('hour', fmc\.booked_at\)/);
});

test('emails sent bucket query filters by period and event type', () => {
    const sql = buildEmailsSentByBucketQuery(PERIOD_CONFIG_7D);

    assert.match(sql, /FROM contact_instantly_events cie/);
    assert.match(sql, /cie\.agency_id = \$1/);
    assert.match(sql, /event_type = 'email_sent'/);
    assert.doesNotMatch(sql, /LOWER\(COALESCE\(cie\.event_type/);
    assert.match(sql, /GROUP BY 1/);
});

test('follow-up stats query filters by selected window and sent status', () => {
    const sql = buildFollowUpStatsQuery(`NOW() - INTERVAL '7 days'`);

    assert.match(sql, /FROM follow_up_sends fus/);
    assert.match(sql, /fus\.client_id = \$1/);
    assert.match(sql, /fus\.status = 'sent'/);
    assert.match(sql, /fus\.updated_at >= NOW\(\) - INTERVAL '7 days'/);
});

test('recent events query keeps client_id-first filter and limit', () => {
    const sql = buildInstantlyRecentEventsQuery(PERIOD_CONFIG_7D.eventFloorSql, '');

    assert.match(sql, /cie\.client_id = \$2/);
    assert.match(sql, /LIMIT 25/);
    assert.doesNotMatch(sql, /WITH period_events AS/);
});

test('generateBucketSeries returns expected bucket counts', () => {
    const anchor = new Date('2026-06-07T15:30:00.000Z');

    assert.equal(generateBucketSeries(PERIOD_CONFIG_24H, anchor).length, 24);
    assert.equal(generateBucketSeries(PERIOD_CONFIG_7D, anchor).length, 7);
    assert.equal(generateBucketSeries({ period: '30d', bucketUnit: 'day' }, anchor).length, 30);
    assert.equal(generateBucketSeries({ period: '90d', bucketUnit: 'day' }, anchor).length, 90);
});

test('mergeAnalyticsBuckets fills missing buckets with zero counts', () => {
    const periodConfig = PERIOD_CONFIG_7D;
    const series = generateBucketSeries(periodConfig);
    const [firstBucket, secondBucket] = series;

    const merged = mergeAnalyticsBuckets({
        periodConfig,
        eventBucketRows: [{ bucket: firstBucket.bucket, count: 12 }],
        emailsSentBucketRows: [{ bucket: firstBucket.bucket, count: 9 }],
        positiveReplyBucketRows: [{ bucket: secondBucket.bucket, count: 3 }],
        meetingsBookedBucketRows: [{ bucket: secondBucket.bucket, count: 2 }]
    });

    assert.equal(merged.length, 7);
    assert.equal(merged[0].bucket, firstBucket.bucket);
    assert.equal(merged[0].count, 12);
    assert.equal(merged[0].emails_sent, 9);
    assert.equal(merged[0].positive_replies, 0);
    assert.equal(merged[0].meetings_booked, 0);
    assert.equal(merged[1].positive_replies, 3);
    assert.equal(merged[1].meetings_booked, 2);
    assert.equal(merged[1].count, 0);
    assert.equal(merged[1].emails_sent, 0);
});

test('emails sent core query returns counts and buckets from one scan', () => {
    const sql = buildEmailsSentCoreSql(PERIOD_CONFIG_7D);

    assert.match(sql, /WITH sent AS MATERIALIZED/);
    assert.match(sql, /event_type = 'email_sent'/);
    assert.match(sql, /AS emails_sent/);
    assert.match(sql, /AS contacts_emailed/);
    assert.match(sql, /AS buckets/);
});

test('mergeCoreAndDetailsAnalytics keeps core outreach metrics and overlays event counts', () => {
    const merged = mergeCoreAndDetailsAnalytics(
        {
            summary: {
                emails_sent: 12,
                contacts_emailed: 8,
                positive_replies: 3,
                meetings_booked: 1
            },
            byHour: [
                { bucket: 'a', label: 'A', count: 0, emails_sent: 4, positive_replies: 1, meetings_booked: 0 },
                { bucket: 'b', label: 'B', count: 0, emails_sent: 8, positive_replies: 2, meetings_booked: 1 }
            ]
        },
        {
            summary: {
                total_events: 40,
                emails_sent: 99,
                positive_replies: 0,
                meetings_booked: 0
            },
            byHour: [
                { bucket: 'a', label: 'A', count: 10, emails_sent: 0, positive_replies: 0, meetings_booked: 0 },
                { bucket: 'b', label: 'B', count: 30, emails_sent: 0, positive_replies: 0, meetings_booked: 0 }
            ],
            eventTypeRows: [{ event_type: 'email_sent' }],
            recentEvents: [{ id: '1' }],
            followUpStats: { follow_up_sent: 2 }
        }
    );

    assert.equal(merged.summary.emails_sent, 12);
    assert.equal(merged.summary.positive_replies, 3);
    assert.equal(merged.summary.meetings_booked, 1);
    assert.equal(merged.summary.total_events, 40);
    assert.equal(merged.byHour[0].count, 10);
    assert.equal(merged.byHour[0].emails_sent, 4);
    assert.equal(merged.followUpStats.follow_up_sent, 2);
    assert.equal(merged.recentEvents.length, 1);
});
