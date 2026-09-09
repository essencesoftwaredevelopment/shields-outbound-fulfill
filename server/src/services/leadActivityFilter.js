/**
 * All Leads "What someone has done (or not done)" filter.
 *
 * Instantly metrics count rows in contact_instantly_events. Shields Outbound
 * enrichment (founder/email find, verify, shopping audit) is the same field:
 * 0/1 occurrences on contact timestamps or related tables. Added to campaign
 * counts contact_instantly_campaigns rows and can WHERE a specific campaign.
 * Instantly Status is a snapshot (a property) and is not this field.
 */

export const LEAD_ACTIVITY_FIELD_KEY = 'lead_activity';

function instantlyEvent(value, label, aliases = [value]) {
    return {
        value,
        label,
        aliases,
        source: 'instantly',
        group: 'Instantly',
        kind: 'instantly_event'
    };
}

function shieldsEvent(value, label, extras = {}) {
    return {
        value,
        label,
        aliases: extras.aliases || [value],
        source: 'shields',
        group: 'Shields Outbound',
        kind: extras.kind,
        column: extras.column || null
    };
}

export const LEAD_ACTIVITY_EVENT_TYPES = [
    instantlyEvent('email_sent', 'Email Sent'),
    instantlyEvent('email_opened', 'Email Opened'),
    instantlyEvent('email_link_clicked', 'Link Clicked'),
    instantlyEvent('reply_received', 'Reply Received', ['reply_received', 'reply', 'replied']),
    instantlyEvent('email_bounced', 'Email Bounced'),
    instantlyEvent('email_complained', 'Marked as spam'),
    instantlyEvent('lead_interested', 'Interested'),
    instantlyEvent('lead_meeting_booked', 'Meeting Booked'),
    instantlyEvent('lead_meeting_completed', 'Meeting Completed'),
    instantlyEvent('lead_closed', 'Closed Won'),
    instantlyEvent('lead_out_of_office', 'Out of Office'),
    instantlyEvent('lead_not_interested', 'Not Interested', ['lead_not_interested', 'not_interested', 'not interested']),
    instantlyEvent('bad_fit', 'Bad Fit', ['bad_fit', 'bad fit']),
    instantlyEvent('lead_wrong_person', 'Wrong Person'),
    instantlyEvent('lead_unsubscribed', 'Unsubscribed'),
    instantlyEvent('lead_no_show', 'No Show'),
    shieldsEvent('founder_found', 'Founder found', { kind: 'founder_found' }),
    shieldsEvent('founder_search_completed', 'Founder search completed', {
        kind: 'timestamp',
        column: 'c.founder_find_completed_at'
    }),
    shieldsEvent('email_found', 'Email found', { kind: 'email_found' }),
    shieldsEvent('email_search_completed', 'Email search completed', {
        kind: 'timestamp',
        column: 'c.email_find_completed_at'
    }),
    shieldsEvent('email_verified', 'Email verified', {
        kind: 'timestamp',
        column: 'c.email_verify_completed_at'
    }),
    shieldsEvent('added_to_campaign', 'Added to campaign', {
        kind: 'campaign_add'
    }),
    shieldsEvent('contacted', 'Contacted', {
        kind: 'timestamp',
        column: 'c.last_contacted_at'
    }),
    shieldsEvent('discovery_call_held', 'Discovery call held', {
        kind: 'timestamp',
        column: 'fi.last_discovery_call_at'
    }),
    shieldsEvent('shopping_audit_run', 'Shopping audit run', { kind: 'shopping_audit' })
];

export const LEAD_ACTIVITY_FREQUENCY_OPS = [
    { key: 'at_least_once', label: 'at least once', needsCount: false },
    { key: 'zero_times', label: 'zero times', needsCount: false },
    { key: 'eq', label: 'equals', needsCount: true },
    { key: 'neq', label: 'does not equal', needsCount: true },
    { key: 'gte', label: 'is at least', needsCount: true },
    { key: 'gt', label: 'is greater than', needsCount: true },
    { key: 'lt', label: 'is less than', needsCount: true },
    { key: 'lte', label: 'is at most', needsCount: true }
];

export const LEAD_ACTIVITY_TIMEFRAME_KINDS = [
    { key: 'in_the_last', label: 'in the last' },
    { key: 'after', label: 'after' },
    { key: 'before', label: 'before' },
    { key: 'between', label: 'between' },
    { key: 'between_dates', label: 'between dates' },
    { key: 'at_least', label: 'at least' },
    { key: 'over_all_time', label: 'over all time' }
];

export const LEAD_ACTIVITY_TIME_UNITS = [
    { key: 'hours', label: 'hours', sql: '1 hour' },
    { key: 'days', label: 'days', sql: '1 day' },
    { key: 'weeks', label: 'weeks', sql: '1 week' }
];

const EVENT_TYPE_MAP = new Map(LEAD_ACTIVITY_EVENT_TYPES.map((item) => [item.value, item]));
const FREQUENCY_OP_MAP = new Map(LEAD_ACTIVITY_FREQUENCY_OPS.map((item) => [item.key, item]));
const TIMEFRAME_KIND_SET = new Set(LEAD_ACTIVITY_TIMEFRAME_KINDS.map((item) => item.key));
const TIME_UNIT_MAP = new Map(LEAD_ACTIVITY_TIME_UNITS.map((item) => [item.key, item]));

const MAX_COUNT = 100000;
const MAX_WINDOW_AMOUNT = 10000;

const WHERE_OPS_MULTI = new Set(['in', 'not_in']);
const WHERE_OPS = new Set(['eq', 'neq', 'in', 'not_in']);
const ACTIVITY_WHERE_CAMPAIGN = 'campaign';
const MAX_WHERE_VALUES = 200;
const MAX_CAMPAIGN_ID_LENGTH = 128;

export function getLeadActivityFilterField(dynamicOptions = {}) {
    return {
        key: LEAD_ACTIVITY_FIELD_KEY,
        label: 'What someone has done (or not done)',
        type: 'activity',
        operators: LEAD_ACTIVITY_FREQUENCY_OPS.map(({ key, label }) => ({ key, label })),
        options: LEAD_ACTIVITY_EVENT_TYPES.map(({ value, label, source, group }) => ({
            value,
            label,
            source,
            group
        })),
        timeframes: LEAD_ACTIVITY_TIMEFRAME_KINDS,
        units: LEAD_ACTIVITY_TIME_UNITS.map(({ key, label }) => ({ key, label })),
        whereDimensions: [
            {
                key: ACTIVITY_WHERE_CAMPAIGN,
                label: 'Campaign',
                eventTypes: ['added_to_campaign'],
                operators: [
                    { key: 'eq', label: 'equals' },
                    { key: 'neq', label: 'does not equal' },
                    { key: 'in', label: 'is any of' },
                    { key: 'not_in', label: 'is none of' }
                ],
                options: Array.isArray(dynamicOptions.campaign) ? dynamicOptions.campaign : []
            }
        ]
    };
}

function asObject(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function asInt(raw, { min = 0, max = MAX_COUNT } = {}) {
    const parsed = Number.parseInt(String(raw ?? ''), 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
    return parsed;
}

function asDateOnly(raw) {
    const value = String(raw || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : value;
}

function asUnit(raw) {
    const key = String(raw || '').trim().toLowerCase();
    return TIME_UNIT_MAP.has(key) ? key : null;
}

function parseTimeframe(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const kind = TIMEFRAME_KIND_SET.has(source.kind) ? source.kind : null;
    if (!kind) return null;

    if (kind === 'over_all_time') {
        return { kind };
    }

    if (kind === 'in_the_last' || kind === 'at_least') {
        const amount = asInt(source.amount, { min: 1, max: MAX_WINDOW_AMOUNT });
        const unit = asUnit(source.unit) || 'days';
        if (amount == null) return null;
        return { kind, amount, unit };
    }

    if (kind === 'after' || kind === 'before') {
        const date = asDateOnly(source.date || source.start);
        if (!date) return null;
        return { kind, date };
    }

    if (kind === 'between') {
        let minAmount = asInt(source.minAmount, { min: 1, max: MAX_WINDOW_AMOUNT });
        let maxAmount = asInt(source.maxAmount, { min: 1, max: MAX_WINDOW_AMOUNT });
        const unit = asUnit(source.unit) || 'days';
        if (minAmount == null || maxAmount == null) return null;
        if (minAmount > maxAmount) {
            const swapped = minAmount;
            minAmount = maxAmount;
            maxAmount = swapped;
        }
        return { kind, minAmount, maxAmount, unit };
    }

    if (kind === 'between_dates') {
        let start = asDateOnly(source.start);
        let end = asDateOnly(source.end);
        if (!start || !end) return null;
        if (start > end) {
            const swapped = start;
            start = end;
            end = swapped;
        }
        return { kind, start, end };
    }

    return null;
}

function asCampaignId(raw) {
    const value = String(raw || '').trim();
    if (!value || value.length > MAX_CAMPAIGN_ID_LENGTH) return null;
    return value;
}

function parseCampaignIds(raw) {
    const values = Array.isArray(raw) ? raw : [raw];
    const ids = [];
    for (const item of values) {
        const id = asCampaignId(item);
        if (!id) continue;
        ids.push(id);
        if (ids.length >= MAX_WHERE_VALUES) break;
    }
    return ids;
}

function parseWhereClauses(eventType, raw) {
    if (raw == null) return [];
    if (!Array.isArray(raw)) return null;
    if (raw.length === 0) return [];
    if (eventType !== 'added_to_campaign') return [];

    const clauses = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const dimension = String(item.dimension || '').trim().toLowerCase();
        const op = String(item.op || '').trim().toLowerCase();
        if (dimension !== ACTIVITY_WHERE_CAMPAIGN || !WHERE_OPS.has(op)) return null;
        const ids = parseCampaignIds(item.value);
        if (!ids.length) return null;
        clauses.push({
            dimension: ACTIVITY_WHERE_CAMPAIGN,
            op,
            value: WHERE_OPS_MULTI.has(op) ? ids : ids[0]
        });
    }
    return clauses;
}

export function frequencyOpNeedsCount(operatorKey) {
    return FREQUENCY_OP_MAP.get(operatorKey)?.needsCount === true;
}

export function parseLeadActivityFilterValue(operatorKey, rawValue) {
    const op = FREQUENCY_OP_MAP.get(String(operatorKey || '').trim().toLowerCase());
    if (!op) return null;

    const source = asObject(rawValue);
    if (!source) return null;

    const eventType = EVENT_TYPE_MAP.get(String(source.eventType || '').trim().toLowerCase());
    if (!eventType) return null;

    const timeframe = parseTimeframe(source.timeframe);
    if (!timeframe) return null;

    const where = parseWhereClauses(eventType.value, source.where);
    if (!where) return null;

    let count = null;
    if (op.needsCount) {
        count = asInt(source.count, { min: 0, max: MAX_COUNT });
        if (count == null) return null;
    } else if (op.key === 'at_least_once') {
        count = 1;
    } else {
        count = 0;
    }

    return {
        eventType: eventType.value,
        aliases: eventType.aliases,
        bounceLike: eventType.value === 'email_bounced',
        kind: eventType.kind || 'instantly_event',
        column: eventType.column || null,
        source: eventType.source || 'instantly',
        op: op.key,
        needsCount: op.needsCount,
        count,
        timeframe,
        where
    };
}

export function leadActivityFilterNeedsJoins(operatorKey, rawValue) {
    const parsed = parseLeadActivityFilterValue(operatorKey, rawValue);
    if (!parsed) return { campaignStats: false, insights: false };
    return {
        campaignStats: parsed.column === 'cs.last_campaign_added_at',
        insights: parsed.column === 'fi.last_discovery_call_at'
    };
}

function intervalSql(unit) {
    return TIME_UNIT_MAP.get(unit)?.sql || '1 day';
}

/** Instantly stores some custom statuses as title-case labels (`Bad Fit`). */
export function expandEventTypeAliases(aliases) {
    const out = new Set();
    for (const raw of aliases || []) {
        const trimmed = String(raw || '').trim();
        if (!trimmed) continue;
        const spaced = trimmed.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
        const lowerSpaced = spaced.toLowerCase();
        out.add(trimmed);
        out.add(trimmed.toLowerCase());
        out.add(spaced);
        out.add(lowerSpaced);
        out.add(lowerSpaced.replace(/\b[a-z]/g, (ch) => ch.toUpperCase()));
    }
    return [...out];
}

function buildEventMatchSql(parsed, bindParam) {
    if (parsed.bounceLike) {
        return `LOWER(COALESCE(cie.event_type, '')) LIKE '%bounce%'`;
    }
    const ref = bindParam(expandEventTypeAliases(parsed.aliases));
    return `cie.event_type = ANY(${ref}::text[])`;
}

function buildTimeframeSql(timeframe, bindParam, column = 'cie.event_timestamp') {
    if (timeframe.kind === 'over_all_time') return '';

    if (timeframe.kind === 'in_the_last') {
        const amountRef = bindParam(timeframe.amount);
        return ` AND ${column} >= NOW() - (${amountRef}::int * INTERVAL '${intervalSql(timeframe.unit)}')`;
    }

    if (timeframe.kind === 'at_least') {
        const amountRef = bindParam(timeframe.amount);
        return ` AND ${column} <= NOW() - (${amountRef}::int * INTERVAL '${intervalSql(timeframe.unit)}')`;
    }

    if (timeframe.kind === 'after') {
        const dateRef = bindParam(timeframe.date);
        return ` AND ${column} >= ${dateRef}::date`;
    }

    if (timeframe.kind === 'before') {
        const dateRef = bindParam(timeframe.date);
        return ` AND ${column} < (${dateRef}::date + INTERVAL '1 day')`;
    }

    if (timeframe.kind === 'between') {
        const maxRef = bindParam(timeframe.maxAmount);
        const minRef = bindParam(timeframe.minAmount);
        const unitSql = intervalSql(timeframe.unit);
        return ` AND ${column} >= NOW() - (${maxRef}::int * INTERVAL '${unitSql}')`
            + ` AND ${column} <= NOW() - (${minRef}::int * INTERVAL '${unitSql}')`;
    }

    if (timeframe.kind === 'between_dates') {
        const startRef = bindParam(timeframe.start);
        const endRef = bindParam(timeframe.end);
        return ` AND ${column} >= ${startRef}::date`
            + ` AND ${column} < (${endRef}::date + INTERVAL '1 day')`;
    }

    return '';
}

function eventsWhereSql(parsed, bindParam) {
    return `cie.agency_id = $1
            AND cie.client_id = $2
            AND cie.contact_id IS NOT NULL
            AND ${buildEventMatchSql(parsed, bindParam)}${buildTimeframeSql(parsed.timeframe, bindParam)}`;
}

function matchingContactsSql(parsed, bindParam, havingOp) {
    const whereSql = eventsWhereSql(parsed, bindParam);
    const countRef = bindParam(parsed.count);
    return `SELECT cie.contact_id
            FROM contact_instantly_events cie
            WHERE ${whereSql}
            GROUP BY cie.contact_id
            HAVING COUNT(*) ${havingOp} ${countRef}`;
}

function existsSql(parsed, bindParam) {
    return `EXISTS (
            SELECT 1
            FROM contact_instantly_events cie
            WHERE cie.contact_id = c.id
              AND ${eventsWhereSql(parsed, bindParam)}
        )`;
}

function campaignWhereSql(parsed, bindParam) {
    const clauses = Array.isArray(parsed.where) ? parsed.where : [];
    const fragments = [];
    for (const clause of clauses) {
        if (clause.dimension !== ACTIVITY_WHERE_CAMPAIGN) continue;
        if (clause.op === 'eq') {
            fragments.push(`ic.instantly_campaign_id = ${bindParam(clause.value)}`);
        } else if (clause.op === 'neq') {
            fragments.push(`ic.instantly_campaign_id <> ${bindParam(clause.value)}`);
        } else if (clause.op === 'in') {
            fragments.push(`ic.instantly_campaign_id = ANY(${bindParam(clause.value)}::text[])`);
        } else if (clause.op === 'not_in') {
            fragments.push(`ic.instantly_campaign_id <> ALL(${bindParam(clause.value)}::text[])`);
        }
    }
    return fragments.length ? ` AND ${fragments.join(' AND ')}` : '';
}

function campaignAddWhereSql(parsed, bindParam) {
    return `ic.agency_id = $1
            AND ic.client_id = $2
            ${campaignWhereSql(parsed, bindParam)}${buildTimeframeSql(parsed.timeframe, bindParam, 'cic.added_at')}`;
}

function campaignAddExistsSql(parsed, bindParam) {
    return `EXISTS (
            SELECT 1
            FROM contact_instantly_campaigns cic
            JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
            WHERE cic.contact_id = c.id
              AND ${campaignAddWhereSql(parsed, bindParam)}
        )`;
}

function campaignAddMatchingSql(parsed, bindParam, havingOp) {
    const countRef = bindParam(parsed.count);
    return `SELECT cic.contact_id
            FROM contact_instantly_campaigns cic
            JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
            WHERE ${campaignAddWhereSql(parsed, bindParam)}
            GROUP BY cic.contact_id
            HAVING COUNT(*) ${havingOp} ${countRef}`;
}

function buildCountedSql(op, count, existsSql, matchingSql) {
    if (op === 'at_least_once' || (op === 'gt' && count === 0) || (op === 'gte' && count === 1) || (op === 'neq' && count === 0)) {
        return existsSql();
    }

    if (op === 'zero_times' || (op === 'eq' && count === 0) || (op === 'lte' && count === 0) || (op === 'lt' && count === 1)) {
        return `NOT ${existsSql()}`;
    }

    if (op === 'gte' && count === 0) {
        return 'TRUE';
    }

    if ((op === 'lt' && count <= 0) || (op === 'lte' && count < 0)) {
        return 'FALSE';
    }

    if (op === 'eq') {
        return `c.id IN (${matchingSql('=')})`;
    }

    if (op === 'neq') {
        return `NOT (c.id IN (${matchingSql('=')}))`;
    }

    if (op === 'gte') {
        return `c.id IN (${matchingSql('>=')})`;
    }

    if (op === 'gt') {
        return `c.id IN (${matchingSql('>')})`;
    }

    if (op === 'lt') {
        return `NOT (c.id IN (${matchingSql('>=')}))`;
    }

    if (op === 'lte') {
        return `NOT (c.id IN (${matchingSql('>')}))`;
    }

    return null;
}

function timestampOccurredSql(column, timeframe, bindParam) {
    return `(${column} IS NOT NULL${buildTimeframeSql(timeframe, bindParam, column)})`;
}

function emailHasDiscoveredSql() {
    return `(
        c.email IS NOT NULL
        AND BTRIM(c.email) <> ''
        AND LOWER(c.email) NOT LIKE '%not found%'
        AND LOWER(c.email) != 'not_found'
    )`;
}

function founderHasValidNameSql() {
    return `(
        c.full_name IS NOT NULL
        AND BTRIM(c.full_name) <> ''
        AND LOWER(BTRIM(c.full_name)) <> 'not found'
        AND LOWER(BTRIM(c.full_name)) NOT LIKE '%not found%'
        AND LOWER(BTRIM(c.full_name)) <> 'not_found'
    )`;
}

function shoppingAuditOccurredSql(timeframe, bindParam) {
    return `EXISTS (
            SELECT 1
            FROM ad_observations ao
            WHERE ao.job_id = c.job_id
              AND ao.domain_normalized = co.domain_normalized
              ${buildTimeframeSql(timeframe, bindParam, 'ao.observed_at')}
        )`;
}

function unaryOccurredSql(parsed, bindParam) {
    if (parsed.kind === 'timestamp' && parsed.column) {
        if (parsed.eventType === 'discovery_call_held' && parsed.timeframe.kind === 'over_all_time') {
            return `(fi.discovery_call_held IS TRUE OR ${timestampOccurredSql(parsed.column, parsed.timeframe, bindParam)})`;
        }
        return timestampOccurredSql(parsed.column, parsed.timeframe, bindParam);
    }
    if (parsed.kind === 'email_found') {
        if (parsed.timeframe.kind === 'over_all_time') return emailHasDiscoveredSql();
        return `(${emailHasDiscoveredSql()} AND ${timestampOccurredSql('c.email_find_completed_at', parsed.timeframe, bindParam)})`;
    }
    if (parsed.kind === 'founder_found') {
        if (parsed.timeframe.kind === 'over_all_time') return founderHasValidNameSql();
        return `(${founderHasValidNameSql()} AND ${timestampOccurredSql('c.founder_find_completed_at', parsed.timeframe, bindParam)})`;
    }
    if (parsed.kind === 'shopping_audit') {
        return shoppingAuditOccurredSql(parsed.timeframe, bindParam);
    }
    return null;
}

function unaryCountSql(occurredSql, op, count) {
    if (op === 'at_least_once' || (op === 'gt' && count === 0) || (op === 'gte' && count === 1) || (op === 'neq' && count === 0)) {
        return occurredSql;
    }
    if (op === 'zero_times' || (op === 'eq' && count === 0) || (op === 'lte' && count === 0) || (op === 'lt' && count === 1)) {
        return `NOT ${occurredSql}`;
    }
    if (op === 'gte' && count === 0) return 'TRUE';
    if ((op === 'lt' && count <= 0) || (op === 'lte' && count < 0)) return 'FALSE';
    if (op === 'eq') return count === 1 ? occurredSql : 'FALSE';
    if (op === 'neq') return count === 1 ? `NOT ${occurredSql}` : occurredSql;
    if (op === 'gte') return count <= 1 ? occurredSql : 'FALSE';
    if (op === 'gt') return count < 1 ? occurredSql : 'FALSE';
    if (op === 'lt') return count <= 1 ? `NOT ${occurredSql}` : 'TRUE';
    if (op === 'lte') return count < 1 ? `NOT ${occurredSql}` : (count >= 1 ? 'TRUE' : 'FALSE');
    return null;
}

function buildInstantlySql(parsed, bindParam) {
    return buildCountedSql(
        parsed.op,
        parsed.count,
        () => existsSql(parsed, bindParam),
        (havingOp) => matchingContactsSql(parsed, bindParam, havingOp)
    );
}

function buildCampaignAddSql(parsed, bindParam) {
    return buildCountedSql(
        parsed.op,
        parsed.count,
        () => campaignAddExistsSql(parsed, bindParam),
        (havingOp) => campaignAddMatchingSql(parsed, bindParam, havingOp)
    );
}

/**
 * Returns a WHERE fragment against contacts alias `c`.
 * Uses $1/$2 for agency_id/client_id (same contract as other lead filters).
 */
export function buildLeadActivityFilterSql(operatorKey, rawValue, bindParam) {
    const parsed = parseLeadActivityFilterValue(operatorKey, rawValue);
    if (!parsed) return null;

    if (parsed.kind === 'instantly_event') {
        return buildInstantlySql(parsed, bindParam);
    }

    if (parsed.kind === 'campaign_add') {
        return buildCampaignAddSql(parsed, bindParam);
    }

    const occurredSql = unaryOccurredSql(parsed, bindParam);
    if (!occurredSql) return null;
    return unaryCountSql(occurredSql, parsed.op, parsed.count);
}
