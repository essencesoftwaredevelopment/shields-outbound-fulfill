import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    LEAD_ACTIVITY_FIELD_KEY,
    frequencyOpNeedsCount,
    parseLeadActivityFilterValue,
    buildLeadActivityFilterSql,
    expandEventTypeAliases,
    getLeadActivityFilterField,
    leadActivityFilterNeedsJoins
} from '../leadActivityFilter.js';

function bindTracker() {
    const params = [];
    const bindParam = (value) => {
        params.push(value);
        return `$${params.length + 2}`;
    };
    return { params, bindParam };
}

function validValue(overrides = {}) {
    return JSON.stringify({
        eventType: 'email_sent',
        count: 3,
        timeframe: { kind: 'in_the_last', amount: 30, unit: 'days' },
        ...overrides,
        timeframe: {
            kind: 'in_the_last',
            amount: 30,
            unit: 'days',
            ...(overrides.timeframe || {})
        }
    });
}

describe('getLeadActivityFilterField', () => {
    it('exposes the Klaviyo-style field contract', () => {
        const field = getLeadActivityFilterField();
        assert.equal(field.key, LEAD_ACTIVITY_FIELD_KEY);
        assert.equal(field.label, 'What someone has done (or not done)');
        assert.equal(field.type, 'activity');
        assert.ok(field.operators.some((op) => op.key === 'at_least_once'));
        assert.ok(field.options.some((opt) => opt.value === 'email_opened'));
        assert.ok(field.options.some((opt) => opt.value === 'email_found'));
        assert.ok(field.options.every((opt) => opt.value !== 'instantly_activity'));
        assert.ok(field.timeframes.some((item) => item.key === 'in_the_last'));
        assert.ok(field.units.some((item) => item.key === 'days'));
        assert.ok(field.whereDimensions.some((item) => item.key === 'campaign'));
        assert.deepEqual(field.whereDimensions[0].eventTypes, ['added_to_campaign']);
    });
});

describe('parseLeadActivityFilterValue', () => {
    it('parses at least once in the last N days', () => {
        const parsed = parseLeadActivityFilterValue('at_least_once', validValue());
        assert.equal(parsed.eventType, 'email_sent');
        assert.equal(parsed.op, 'at_least_once');
        assert.equal(parsed.count, 1);
        assert.equal(parsed.timeframe.kind, 'in_the_last');
        assert.equal(parsed.timeframe.amount, 30);
        assert.equal(parsed.timeframe.unit, 'days');
    });

    it('accepts reply aliases', () => {
        const parsed = parseLeadActivityFilterValue(
            'at_least_once',
            validValue({ eventType: 'reply_received' })
        );
        assert.deepEqual(parsed.aliases, ['reply_received', 'reply', 'replied']);
    });

    it('accepts bad fit with either spelling', () => {
        const parsed = parseLeadActivityFilterValue(
            'at_least_once',
            validValue({ eventType: 'bad_fit' })
        );
        assert.deepEqual(parsed.aliases, ['bad_fit', 'bad fit']);
        assert.ok(expandEventTypeAliases(parsed.aliases).includes('Bad Fit'));
    });

    it('rejects unknown event types', () => {
        assert.equal(
            parseLeadActivityFilterValue('at_least_once', validValue({ eventType: 'state_sync' })),
            null
        );
    });

    it('requires a count for equals', () => {
        assert.equal(
            parseLeadActivityFilterValue('eq', validValue({ count: undefined })),
            null
        );
        const parsed = parseLeadActivityFilterValue('eq', validValue({ count: 4 }));
        assert.equal(parsed.count, 4);
    });

    it('swaps inverted between windows', () => {
        const parsed = parseLeadActivityFilterValue(
            'at_least_once',
            validValue({ timeframe: { kind: 'between', minAmount: 90, maxAmount: 14, unit: 'days' } })
        );
        assert.equal(parsed.timeframe.minAmount, 14);
        assert.equal(parsed.timeframe.maxAmount, 90);
    });
});

describe('frequencyOpNeedsCount', () => {
    it('is false for at least once and zero times', () => {
        assert.equal(frequencyOpNeedsCount('at_least_once'), false);
        assert.equal(frequencyOpNeedsCount('zero_times'), false);
        assert.equal(frequencyOpNeedsCount('eq'), true);
        assert.equal(frequencyOpNeedsCount('gte'), true);
    });
});

describe('buildLeadActivityFilterSql', () => {
    it('uses EXISTS for at least once and binds the window amount', () => {
        const { params, bindParam } = bindTracker();
        const sql = buildLeadActivityFilterSql('at_least_once', validValue(), bindParam);
        assert.match(sql, /EXISTS \(/);
        assert.match(sql, /cie\.agency_id = \$1/);
        assert.match(sql, /cie\.client_id = \$2/);
        assert.match(sql, /cie\.event_type = ANY\(\$3::text\[\]\)/);
        assert.match(sql, /cie\.event_timestamp >= NOW\(\) - \(\$4::int \* INTERVAL '1 day'\)/);
        assert.ok(params[0].includes('email_sent'));
        assert.equal(params[1], 30);
    });

    it('uses NOT EXISTS for zero times', () => {
        const { bindParam } = bindTracker();
        const sql = buildLeadActivityFilterSql('zero_times', validValue(), bindParam);
        assert.match(sql, /^NOT EXISTS \(/);
    });

    it('groups matching contacts for equals N', () => {
        const { params, bindParam } = bindTracker();
        const sql = buildLeadActivityFilterSql('eq', validValue({ count: 3 }), bindParam);
        assert.match(sql, /c\.id IN \(/);
        assert.match(sql, /GROUP BY cie\.contact_id/);
        assert.match(sql, /HAVING COUNT\(\*\) = \$5/);
        assert.equal(params[2], 3);
    });

    it('treats less-than as the inverse of at-least, including zero-activity leads', () => {
        const { bindParam } = bindTracker();
        const sql = buildLeadActivityFilterSql('lt', validValue({ count: 3 }), bindParam);
        assert.match(sql, /^NOT \(c\.id IN \(/);
        assert.match(sql, /HAVING COUNT\(\*\) >= /);
    });

    it('matches Instantly title-case Bad Fit via the bad_fit action', () => {
        const { params, bindParam } = bindTracker();
        buildLeadActivityFilterSql(
            'zero_times',
            validValue({ eventType: 'bad_fit' }),
            bindParam
        );
        assert.ok(params[0].includes('Bad Fit'));
        assert.ok(params[0].includes('bad fit'));
        assert.ok(params[0].includes('bad_fit'));
    });

    it('matches bounced events with LIKE', () => {
        const { bindParam } = bindTracker();
        const sql = buildLeadActivityFilterSql(
            'at_least_once',
            validValue({ eventType: 'email_bounced' }),
            bindParam
        );
        assert.match(sql, /LIKE '%bounce%'/);
        assert.doesNotMatch(sql, /event_type = ANY/);
    });

    it('omits a time bound for over all time', () => {
        const { bindParam } = bindTracker();
        const sql = buildLeadActivityFilterSql(
            'at_least_once',
            validValue({ timeframe: { kind: 'over_all_time' } }),
            bindParam
        );
        assert.doesNotMatch(sql, /event_timestamp/);
    });

    it('builds between-dates as an inclusive calendar range', () => {
        const { params, bindParam } = bindTracker();
        const sql = buildLeadActivityFilterSql(
            'at_least_once',
            validValue({
                timeframe: { kind: 'between_dates', start: '2026-01-01', end: '2026-01-31' }
            }),
            bindParam
        );
        assert.match(sql, /cie\.event_timestamp >= \$4::date/);
        assert.match(sql, /cie\.event_timestamp < \(\$5::date \+ INTERVAL '1 day'\)/);
        assert.equal(params[1], '2026-01-01');
        assert.equal(params[2], '2026-01-31');
    });

    it('returns null for invalid payloads', () => {
        const { bindParam } = bindTracker();
        assert.equal(buildLeadActivityFilterSql('at_least_once', '{}', bindParam), null);
        assert.equal(buildLeadActivityFilterSql('bogus', validValue(), bindParam), null);
    });

    it('matches email found as a Shields occurrence', () => {
        const { bindParam } = bindTracker();
        const sql = buildLeadActivityFilterSql(
            'at_least_once',
            validValue({ eventType: 'email_found' }),
            bindParam
        );
        assert.match(sql, /c\.email IS NOT NULL/);
        assert.match(sql, /c\.email_find_completed_at IS NOT NULL/);
        assert.doesNotMatch(sql, /contact_instantly_events/);
    });

    it('matches shopping audit run against ad_observations', () => {
        const { bindParam } = bindTracker();
        const sql = buildLeadActivityFilterSql(
            'zero_times',
            validValue({ eventType: 'shopping_audit_run', timeframe: { kind: 'over_all_time' } }),
            bindParam
        );
        assert.match(sql, /^NOT EXISTS \(/);
        assert.match(sql, /ad_observations ao/);
        assert.match(sql, /ao\.domain_normalized = co\.domain_normalized/);
    });

    it('counts added-to-campaign against campaign memberships', () => {
        const { bindParam } = bindTracker();
        const sql = buildLeadActivityFilterSql(
            'at_least_once',
            validValue({ eventType: 'added_to_campaign' }),
            bindParam
        );
        assert.match(sql, /contact_instantly_campaigns cic/);
        assert.match(sql, /instantly_campaigns ic/);
        assert.match(sql, /cic\.added_at >= NOW\(\)/);
        assert.doesNotMatch(sql, /cs\.last_campaign_added_at/);
        const counted = buildLeadActivityFilterSql(
            'eq',
            validValue({ eventType: 'added_to_campaign', count: 2 }),
            bindParam
        );
        assert.match(counted, /HAVING COUNT\(\*\) = /);
    });

    it('filters added-to-campaign by campaign WHERE', () => {
        const { params, bindParam } = bindTracker();
        const sql = buildLeadActivityFilterSql(
            'at_least_once',
            validValue({
                eventType: 'added_to_campaign',
                where: [{ dimension: 'campaign', op: 'eq', value: 'camp-1' }]
            }),
            bindParam
        );
        assert.match(sql, /ic\.instantly_campaign_id = \$3/);
        assert.equal(params[0], 'camp-1');
        assert.equal(params[1], 30);
    });

    it('rejects an incomplete campaign WHERE', () => {
        const { bindParam } = bindTracker();
        assert.equal(
            buildLeadActivityFilterSql(
                'at_least_once',
                validValue({
                    eventType: 'added_to_campaign',
                    where: [{ dimension: 'campaign', op: 'eq', value: '' }]
                }),
                bindParam
            ),
            null
        );
    });
});

describe('leadActivityFilterNeedsJoins', () => {
    it('does not request campaign stats for added to campaign', () => {
        assert.deepEqual(
            leadActivityFilterNeedsJoins('at_least_once', validValue({ eventType: 'added_to_campaign' })),
            { campaignStats: false, insights: false }
        );
        assert.deepEqual(
            leadActivityFilterNeedsJoins('at_least_once', validValue({ eventType: 'email_sent' })),
            { campaignStats: false, insights: false }
        );
        assert.deepEqual(
            leadActivityFilterNeedsJoins('at_least_once', validValue({ eventType: 'discovery_call_held' })),
            { campaignStats: false, insights: true }
        );
    });
});
