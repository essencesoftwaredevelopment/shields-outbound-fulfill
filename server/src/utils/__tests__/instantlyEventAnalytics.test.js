import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildFollowUpStatsQuery,
    buildInstantlyEventBucketCountsQuery,
    buildInstantlyEventPeriodFilterSql,
    buildInstantlyEventSummaryQuery,
    buildInstantlyEventTypesQuery,
    buildInstantlyRecentEventsQuery,
    buildMeetingsBookedByBucketQuery,
    generateBucketSeries,
    mergeAnalyticsBuckets
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
});

test('bucket and event-type queries use direct grouped scans', () => {
    const bucketSql = buildInstantlyEventBucketCountsQuery(PERIOD_CONFIG_7D, PERIOD_FILTER, '');
    const eventTypeSql = buildInstantlyEventTypesQuery(PERIOD_FILTER, '');

    assert.doesNotMatch(bucketSql, /WITH period_events AS/);
    assert.match(bucketSql, /GROUP BY 1/);
    assert.doesNotMatch(eventTypeSql, /SELECT DISTINCT/);
    assert.match(eventTypeSql, /GROUP BY 1/);
});

test('meetings booked bucket query filters by period and event type', () => {
    const sql = buildMeetingsBookedByBucketQuery(PERIOD_CONFIG_7D);

    assert.match(sql, /FROM contact_instantly_events cie/);
    assert.match(sql, /cie\.client_id = \$2/);
    assert.match(sql, /lead_meeting_booked/);
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
    const series = generateBucketSeries(periodConfig, new Date('2026-06-07T12:00:00.000Z'));
    const [firstBucket, secondBucket] = series;

    const merged = mergeAnalyticsBuckets({
        periodConfig,
        eventBucketRows: [{ bucket: firstBucket.bucket, count: 12 }],
        positiveReplyBucketRows: [{ bucket: secondBucket.bucket, count: 3 }],
        meetingsBookedBucketRows: [{ bucket: secondBucket.bucket, count: 2 }]
    });

    assert.equal(merged.length, 7);
    assert.equal(merged[0].bucket, firstBucket.bucket);
    assert.equal(merged[0].count, 12);
    assert.equal(merged[0].positive_replies, 0);
    assert.equal(merged[0].meetings_booked, 0);
    assert.equal(merged[1].positive_replies, 3);
    assert.equal(merged[1].meetings_booked, 2);
    assert.equal(merged[1].count, 0);
});
