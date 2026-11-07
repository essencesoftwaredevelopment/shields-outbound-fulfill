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

export const MAX_CUSTOM_RANGE_DAYS = 366;

const CUSTOM_PERIOD_PATTERN = /^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/;
const DAY_MS = 86_400_000;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function invalidPeriod(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function parseUtcDate(text) {
    const [year, month, day] = text.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
        ? date
        : null;
}

function formatDay(date, withYear) {
    const text = `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}`;
    return withYear ? `${text}, ${date.getUTCFullYear()}` : text;
}

function customRangeLabel(from, to) {
    if (from.getTime() === to.getTime()) return formatDay(to, true);
    const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
    return `${formatDay(from, !sameYear)} – ${formatDay(to, true)}`;
}

/**
 * A custom window: whole UTC days from `fromText` through `toText`, inclusive.
 * The dates are validated here before they are inlined into SQL, so the
 * query builders can treat the floor and ceiling like the preset fragments.
 */
export function buildCustomAnalyticsPeriod(fromText, toText, now = new Date()) {
    const from = parseUtcDate(fromText);
    const to = parseUtcDate(toText);
    if (!from || !to) throw invalidPeriod('Dates must be real calendar dates.');
    if (from > to) throw invalidPeriod('The start date must be on or before the end date.');
    // One day of slack so a viewer ahead of UTC can still pick their own today.
    const latestAllowed = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS;
    if (to.getTime() > latestAllowed) throw invalidPeriod('The end date can’t be in the future.');
    const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
    if (days > MAX_CUSTOM_RANGE_DAYS) {
        throw invalidPeriod(`Pick a range of ${MAX_CUSTOM_RANGE_DAYS} days or less.`);
    }

    const rangeEnd = new Date(to.getTime() + DAY_MS);
    const bucketUnit = days === 1 ? 'hour' : 'day';
    return {
        period: `custom:${fromText}:${toText}`,
        label: customRangeLabel(from, to),
        bucketUnit,
        custom: true,
        rangeStart: from,
        rangeEnd,
        eventFloorSql: `TIMESTAMPTZ '${fromText} 00:00:00+00'`,
        eventCeilSql: `TIMESTAMPTZ '${rangeEnd.toISOString().slice(0, 10)} 00:00:00+00'`,
        bucketTruncSql: `DATE_TRUNC('${bucketUnit}', cie.event_timestamp)`
    };
}

/** A preset key ('24h', '7d', …) or 'custom:YYYY-MM-DD:YYYY-MM-DD'. Unknown presets fall back to 24h. */
export function resolveInstantlyAnalyticsPeriod(raw, now = new Date()) {
    const key = String(raw || '').trim().toLowerCase();
    const match = key.match(CUSTOM_PERIOD_PATTERN);
    if (match) return buildCustomAnalyticsPeriod(match[1], match[2], now);
    return INSTANTLY_ANALYTICS_PERIODS[key] || INSTANTLY_ANALYTICS_PERIODS['24h'];
}
