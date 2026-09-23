// Analytics tab windows. Shared by the analytics route and the snapshot sweep.
export const INSTANTLY_ANALYTICS_PERIODS = {
    '24h': {
        period: '24h',
        label: 'Last 24 hours',
        bucketUnit: 'hour',
        bucketStartSql: `DATE_TRUNC('hour', NOW() - INTERVAL '23 hours')`,
        bucketEndSql: `DATE_TRUNC('hour', NOW())`,
        eventFloorSql: `NOW() - INTERVAL '24 hours'`,
        bucketTruncSql: `DATE_TRUNC('hour', cie.event_timestamp)`,
        bucketLabelSql: `TO_CHAR(hours.bucket, 'HH24:00')`
    },
    '7d': {
        period: '7d',
        label: 'Last 7 days',
        bucketUnit: 'day',
        bucketStartSql: `DATE_TRUNC('day', NOW() - INTERVAL '6 days')`,
        bucketEndSql: `DATE_TRUNC('day', NOW())`,
        eventFloorSql: `NOW() - INTERVAL '7 days'`,
        bucketTruncSql: `DATE_TRUNC('day', cie.event_timestamp)`,
        bucketLabelSql: `TO_CHAR(hours.bucket, 'Mon DD')`
    },
    '30d': {
        period: '30d',
        label: 'Last 30 days',
        bucketUnit: 'day',
        bucketStartSql: `DATE_TRUNC('day', NOW() - INTERVAL '29 days')`,
        bucketEndSql: `DATE_TRUNC('day', NOW())`,
        eventFloorSql: `NOW() - INTERVAL '30 days'`,
        bucketTruncSql: `DATE_TRUNC('day', cie.event_timestamp)`,
        bucketLabelSql: `TO_CHAR(hours.bucket, 'Mon DD')`
    },
    '90d': {
        period: '90d',
        label: 'Last 90 days',
        bucketUnit: 'day',
        bucketStartSql: `DATE_TRUNC('day', NOW() - INTERVAL '89 days')`,
        bucketEndSql: `DATE_TRUNC('day', NOW())`,
        eventFloorSql: `NOW() - INTERVAL '90 days'`,
        bucketTruncSql: `DATE_TRUNC('day', cie.event_timestamp)`,
        bucketLabelSql: `TO_CHAR(hours.bucket, 'Mon DD')`
    }
};
