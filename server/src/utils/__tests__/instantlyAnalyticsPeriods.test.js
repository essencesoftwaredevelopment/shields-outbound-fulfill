import test from 'node:test';
import assert from 'node:assert/strict';
import {
    INSTANTLY_ANALYTICS_PERIODS,
    MAX_CUSTOM_RANGE_DAYS,
    buildCustomAnalyticsPeriod,
    resolveInstantlyAnalyticsPeriod
} from '../instantlyAnalyticsPeriods.js';
import {
    buildEmailsSentCoreSql,
    buildFollowUpStatsQuery,
    buildInstantlyEventPeriodFilterSql,
    buildInstantlyEventTypesQuery,
    buildInstantlyRecentEventsQuery,
    buildMeetingsBookedCoreSql,
    generateBucketSeries
} from '../instantlyEventAnalytics.js';
import { buildPositiveRepliesCoreSql } from '../positiveReplyAnalytics.js';

const NOW = new Date('2026-11-08T15:00:00Z');

test('presets resolve unchanged and unknown keys fall back to 24h', () => {
    assert.equal(resolveInstantlyAnalyticsPeriod('7d', NOW), INSTANTLY_ANALYTICS_PERIODS['7d']);
    assert.equal(resolveInstantlyAnalyticsPeriod('nonsense', NOW), INSTANTLY_ANALYTICS_PERIODS['24h']);
    assert.equal(resolveInstantlyAnalyticsPeriod(undefined, NOW), INSTANTLY_ANALYTICS_PERIODS['24h']);
});

test('a custom range covers whole UTC days, end date included', () => {
    const period = resolveInstantlyAnalyticsPeriod('custom:2026-10-01:2026-10-15', NOW);
    assert.equal(period.period, 'custom:2026-10-01:2026-10-15');
    assert.equal(period.custom, true);
    assert.equal(period.bucketUnit, 'day');
    assert.equal(period.label, 'Oct 1 – Oct 15, 2026');
    assert.equal(period.eventFloorSql, "TIMESTAMPTZ '2026-10-01 00:00:00+00'");
    assert.equal(period.eventCeilSql, "TIMESTAMPTZ '2026-10-16 00:00:00+00'");
});

test('a single day uses hourly buckets and a cross-year range shows both years', () => {
    const day = buildCustomAnalyticsPeriod('2026-11-02', '2026-11-02', NOW);
    assert.equal(day.bucketUnit, 'hour');
    assert.equal(day.label, 'Nov 2, 2026');
    assert.equal(generateBucketSeries(day).length, 24);
    assert.equal(buildCustomAnalyticsPeriod('2025-12-20', '2026-01-05', NOW).label, 'Dec 20, 2025 – Jan 5, 2026');
});

test('custom bucket series has one point per day in the range', () => {
    const series = generateBucketSeries(buildCustomAnalyticsPeriod('2026-10-30', '2026-11-02', NOW));
    assert.deepEqual(series.map((row) => row.bucket), [
        '2026-10-30T00:00:00Z', '2026-10-31T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'
    ]);
});

test('bad custom ranges are rejected with a 400', () => {
    const cases = [
        ['custom:2026-02-30:2026-03-01', /real calendar dates/],
        ['custom:2026-10-15:2026-10-01', /on or before/],
        ['custom:2026-11-01:2026-11-20', /future/],
        ['custom:2024-01-01:2026-11-01', new RegExp(`${MAX_CUSTOM_RANGE_DAYS} days`)]
    ];
    for (const [raw, message] of cases) {
        assert.throws(() => resolveInstantlyAnalyticsPeriod(raw, NOW), (error) => error.statusCode === 400 && message.test(error.message));
    }
});

test('one day ahead of UTC is still allowed as an end date', () => {
    assert.doesNotThrow(() => resolveInstantlyAnalyticsPeriod('custom:2026-11-01:2026-11-09', NOW));
});

test('only validated dates reach SQL: anything else is treated as a preset key', () => {
    const injected = resolveInstantlyAnalyticsPeriod("custom:2026-10-01:2026-10-15' OR 1=1 --", NOW);
    assert.equal(injected, INSTANTLY_ANALYTICS_PERIODS['24h']);
});

test('custom ranges add an upper bound to every query; presets stay unchanged', () => {
    const custom = buildCustomAnalyticsPeriod('2026-10-01', '2026-10-15', NOW);
    const ceil = "< TIMESTAMPTZ '2026-10-16 00:00:00+00'";
    const sqls = [
        buildInstantlyEventPeriodFilterSql(custom.eventFloorSql, 'cie', custom.eventCeilSql),
        buildEmailsSentCoreSql(custom),
        buildMeetingsBookedCoreSql(custom),
        buildPositiveRepliesCoreSql(custom.eventFloorSql, custom.bucketUnit, '', custom.eventCeilSql),
        buildInstantlyEventTypesQuery(custom.eventFloorSql, '', custom.eventCeilSql),
        buildInstantlyRecentEventsQuery(custom.eventFloorSql, '', custom.eventCeilSql),
        buildFollowUpStatsQuery(custom.eventFloorSql, '', custom.eventCeilSql)
    ];
    for (const sql of sqls) assert.ok(sql.includes(ceil), sql.slice(0, 200));

    const preset = INSTANTLY_ANALYTICS_PERIODS['7d'];
    for (const sql of [
        buildEmailsSentCoreSql(preset),
        buildMeetingsBookedCoreSql(preset),
        buildPositiveRepliesCoreSql(preset.eventFloorSql, preset.bucketUnit),
        buildFollowUpStatsQuery(preset.eventFloorSql)
    ]) {
        assert.ok(!sql.includes(' < '), sql.slice(0, 200));
    }
});
