import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isAnalyticsSnapshotSweepEnabled,
    loadCoreAnalyticsWithSnapshot,
    rebuildSnapshotAnalytics
} from '../analyticsSnapshots.js';
import { generateBucketSeries } from '../../utils/instantlyEventAnalytics.js';
import { INSTANTLY_ANALYTICS_PERIODS } from '../../utils/instantlyAnalyticsPeriods.js';

const PERIOD_7D = INSTANTLY_ANALYTICS_PERIODS['7d'];

function storedPayload() {
    const series = generateBucketSeries(PERIOD_7D);
    return {
        summary: { emails_sent: 30, contacts_emailed: 20, positive_replies: 4, meetings_booked: 1 },
        byHour: series.map((row, index) => ({
            ...row,
            count: 0,
            emails_sent: index === 0 ? 30 : 0,
            positive_replies: index === 6 ? 4 : 0,
            meetings_booked: index === 6 ? 1 : 0
        }))
    };
}

test('sweep is on in production and off elsewhere unless forced', () => {
    assert.equal(isAnalyticsSnapshotSweepEnabled({ NODE_ENV: 'production' }), true);
    assert.equal(isAnalyticsSnapshotSweepEnabled({ NODE_ENV: 'development' }), false);
    assert.equal(isAnalyticsSnapshotSweepEnabled({ NODE_ENV: 'development', ANALYTICS_SNAPSHOT_ENABLED: 'true' }), true);
    assert.equal(isAnalyticsSnapshotSweepEnabled({ NODE_ENV: 'production', ANALYTICS_SNAPSHOT_ENABLED: 'false' }), false);
});

test('rebuildSnapshotAnalytics keeps stored counts on the current bucket series', () => {
    const rebuilt = rebuildSnapshotAnalytics(PERIOD_7D, storedPayload());

    assert.equal(rebuilt.summary.emails_sent, 30);
    assert.equal(rebuilt.byHour.length, 7);
    assert.equal(rebuilt.byHour[0].emails_sent, 30);
    assert.equal(rebuilt.byHour[6].positive_replies, 4);
    assert.equal(rebuilt.byHour[6].meetings_booked, 1);
});

test('rebuildSnapshotAnalytics drops buckets that aged out of the window', () => {
    const payload = storedPayload();
    payload.byHour.unshift({ bucket: '2000-01-01T00:00:00Z', label: 'Jan 01', count: 0, emails_sent: 99 });

    const rebuilt = rebuildSnapshotAnalytics(PERIOD_7D, payload);

    assert.equal(rebuilt.byHour.length, 7);
    assert.ok(rebuilt.byHour.every((row) => row.bucket !== '2000-01-01T00:00:00Z'));
});

test('a fresh snapshot is served without running the core aggregates', async () => {
    const queries = [];
    const computedAt = new Date();
    const pool = {
        query: async (sql) => {
            queries.push(sql);
            return { rows: [{ payload: storedPayload(), computed_at: computedAt }] };
        }
    };

    const result = await loadCoreAnalyticsWithSnapshot({
        pool,
        agencyId: 'agency',
        sqlClientId: 1,
        periodConfig: PERIOD_7D
    });

    assert.equal(queries.length, 1);
    assert.match(queries[0], /FROM client_analytics_snapshots/);
    assert.equal(result.analytics.summary.positive_replies, 4);
    assert.equal(result.computedAt, computedAt);
});

test('a missing snapshot is computed live and stored', async () => {
    const queries = [];
    const pool = {
        query: async (sql) => {
            queries.push(sql);
            if (/FROM client_analytics_snapshots/.test(sql)) return { rows: [] };
            if (/INSERT INTO client_analytics_snapshots/.test(sql)) return { rows: [{ computed_at: new Date() }] };
            return { rows: [] };
        }
    };

    const result = await loadCoreAnalyticsWithSnapshot({
        pool,
        agencyId: 'agency',
        sqlClientId: 2,
        periodConfig: PERIOD_7D
    });

    assert.ok(queries.some((sql) => /INSERT INTO client_analytics_snapshots/.test(sql)));
    assert.equal(result.analytics.byHour.length, 7);
    assert.equal(result.analytics.summary.emails_sent, 0);
});
