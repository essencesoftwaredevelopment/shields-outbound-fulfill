/**
 * Metrics tab: one funnel from sending to cash, for a selectable period.
 *
 * - Sending: Instantly campaign analytics for the period (sent, new contacts,
 *   bounces) + the sending runway (capacity, queued leads).
 * - Replies: positive replies with the same lifecycle rules as the Analytics
 *   tab (utils/positiveReplyAnalytics.js), split per campaign ("script").
 * - Sales + money: the manual sales log (sales_calls, Calendly bookings added
 *   automatically) and outreach cost lines, plus enrichment spend from
 *   job_stage_costs.
 *
 * Periods are whole UTC days: [start, end). Activity metrics count what
 * happened inside the period (calls held, proposals sent, deals won), so a
 * ratio like close rate compares counts from the same window, not one cohort.
 */
import { pool } from '../config/db.js';
import { instantlyRequest } from './instantlyState.js';
import { loadSendingRunway } from './sendingRunway.js';
import { syncCalendlyBookings, listSalesCalls, listOutreachCosts } from './db/funnelInputs.js';
import { buildPositiveRepliesLifecycleCtesSql } from '../utils/positiveReplyAnalytics.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const DAYS_PER_MONTH = 365.25 / 12;
const STALLED_AFTER_DAYS = 7;
const INSTANTLY_CACHE_TTL_MS = 10 * 60 * 1000;

export const METRIC_PERIODS = {
    '7d': 'Last 7 days',
    last_week: 'Last week (Mon–Sun)',
    '14d': 'Last 14 days',
    '30d': 'Last 30 days',
    this_month: 'This month',
    last_month: 'Last month',
    '90d': 'Last 90 days'
};

function utcMidnight(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date, days) {
    return new Date(date.getTime() + days * DAY_MS);
}

function isoDay(date) {
    return date.toISOString().slice(0, 10);
}

/** Period as whole UTC days [start, end); `end` never goes past tomorrow 00:00. */
export function resolvePeriod(key, now = new Date()) {
    const periodKey = Object.prototype.hasOwnProperty.call(METRIC_PERIODS, key) ? key : '7d';
    const today = utcMidnight(now);
    const tomorrow = addDays(today, 1);
    let start;
    let end = tomorrow;
    if (periodKey === '7d') start = addDays(today, -6);
    else if (periodKey === '14d') start = addDays(today, -13);
    else if (periodKey === '30d') start = addDays(today, -29);
    else if (periodKey === '90d') start = addDays(today, -89);
    else if (periodKey === 'last_week') {
        const sinceMonday = (today.getUTCDay() + 6) % 7;
        end = addDays(today, -sinceMonday);
        start = addDays(end, -7);
    } else if (periodKey === 'this_month') {
        start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    } else {
        end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
        start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    }
    return {
        key: periodKey,
        label: METRIC_PERIODS[periodKey],
        start,
        end,
        days: Math.round((end - start) / DAY_MS),
        workingDays: countWorkingDays(start, end)
    };
}

/** Mon–Fri days in [start, end). */
export function countWorkingDays(start, end) {
    let count = 0;
    for (let day = utcMidnight(start); day < end; day = addDays(day, 1)) {
        const weekday = day.getUTCDay();
        if (weekday !== 0 && weekday !== 6) count += 1;
    }
    return count;
}

export function ratio(numerator, denominator) {
    return denominator > 0 ? numerator / denominator : null;
}

function round(value, digits = 1) {
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function toTime(value) {
    if (value === null || value === undefined || value === '') return null;
    const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? Date.parse(`${value}T00:00:00Z`)
        : new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
}

function within(value, start, end) {
    const time = toTime(value);
    return time !== null && time >= start.getTime() && time < end.getTime();
}

function isMonthStart(date) {
    return date.getUTCDate() === 1 && date.getTime() === utcMidnight(date).getTime();
}

/** Calendar months in [start, end) when both ends fall on a 1st, else null. */
function wholeMonthsBetween(start, end) {
    if (!isMonthStart(start) || !isMonthStart(end)) return null;
    return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
}

/**
 * The window costs are charged over. "This month" takes the whole calendar
 * month, so a monthly cost counts in full mid-month instead of by days so far.
 */
export function costWindowForPeriod(period) {
    if (period.key === 'this_month') {
        const start = period.start;
        return { start, end: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) };
    }
    return { start: period.start, end: period.end };
}

/**
 * What each cost line charges a window. Monthly costs count every month: once
 * per calendar month for whole-month windows, else days ÷ average month. A
 * one-time cost belongs to its month: in full when the window covers that
 * month, else the share of the month's days the window overlaps.
 */
export function costLinesForPeriod(lines, start, end) {
    const wholeMonths = wholeMonthsBetween(start, end);
    const windowMonths = wholeMonths ?? (end - start) / DAY_MS / DAYS_PER_MONTH;
    return (lines || []).map((line) => {
        const amount = Number(line.monthly_amount) || 0;
        let charged = 0;
        if (line.cadence === 'one_time') {
            const monthTime = toTime(line.cost_month);
            if (monthTime !== null) {
                const monthStart = new Date(monthTime);
                const monthEnd = Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1);
                const overlap = Math.max(0, Math.min(end.getTime(), monthEnd) - Math.max(start.getTime(), monthTime));
                charged = amount * overlap / (monthEnd - monthTime);
            }
        } else {
            charged = amount * windowMonths;
        }
        return {
            id: line.id,
            label: line.label,
            category: line.category,
            cadence: line.cadence === 'one_time' ? 'one_time' : 'monthly',
            monthlyAmount: amount,
            amount: round(charged, 2)
        };
    }).filter((line) => line.amount > 0);
}

/**
 * Sales + money metrics from the sales log for [start, end).
 * Pure; `costs.total` is the outreach spend for the same period.
 */
/** One key per person, so rebookings and Instantly + Calendly duplicates count once. */
function personKey(call) {
    if (call.contact_id !== null && call.contact_id !== undefined) return `contact:${call.contact_id}`;
    const email = String(call.contact_email || '').trim().toLowerCase();
    return email ? `email:${email}` : `call:${call.id}`;
}

const CALL_STATUS_TEXT = { booked: 'Booked', held: 'Held', no_show: 'No-show', canceled: 'Canceled' };
const LOST_REASON_TEXT = {
    price: 'price', timing: 'timing', competitor: 'went with someone else',
    no_budget: 'no budget', ghosted: 'ghosted', not_a_fit: 'not a fit'
};

function isoDate(value) {
    const time = toTime(value);
    return time === null ? null : new Date(time).toISOString();
}

function listEntry(call, detail, date) {
    return {
        salesCallId: call.id ?? null,
        name: call.contact_name || null,
        company: call.company || null,
        email: call.contact_email || null,
        date: isoDate(date),
        detail
    };
}

function byDateDesc(a, b) {
    return (b.date || '').localeCompare(a.date || '');
}

/**
 * One call per person: their latest by `dateOf`. `merge` can derive fields
 * from all of that person's calls (e.g. good fit if any call said so).
 */
function onePerPerson(calls, dateOf, merge = null) {
    const groups = new Map();
    for (const call of calls) {
        const key = personKey(call);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(call);
    }
    return [...groups.values()].map((group) => {
        const latest = group.reduce((a, b) => ((toTime(dateOf(b)) ?? 0) > (toTime(dateOf(a)) ?? 0) ? b : a));
        return merge ? { ...latest, ...merge(group) } : latest;
    });
}

/** The people behind each Sales card, for the card's list popup. */
function buildSalesLists({ bookedInPeriod, instantlyBooked, held, proposals, won, lost }) {
    // Calls booked: one row per person; their latest live booking, else their canceled one.
    const byPerson = new Map();
    for (const call of bookedInPeriod) {
        const key = personKey(call);
        const current = byPerson.get(key);
        const better = !current
            || (current.call_status === 'canceled' && call.call_status !== 'canceled')
            || ((current.call_status === 'canceled') === (call.call_status === 'canceled') && toTime(call.booked_at) > toTime(current.booked_at));
        if (better) byPerson.set(key, call);
    }
    const callsBooked = [...byPerson.values()].map((call) => listEntry(call, CALL_STATUS_TEXT[call.call_status] || call.call_status, call.booked_at));
    for (const entry of instantlyBooked) {
        if (byPerson.has(`contact:${entry.contact_id}`)) continue;
        callsBooked.push({
            salesCallId: null,
            name: entry.name || null,
            company: entry.company || null,
            email: entry.email || null,
            date: isoDate(entry.booked_at),
            detail: 'Marked "meeting booked" in Instantly'
        });
    }

    // Calls held only (marked held, or past and not marked a no-show).
    const showRate = held.map((call) => listEntry(
        call,
        call.call_status === 'booked' ? 'Held (assumed)' : 'Held',
        call.call_at
    ));

    const qualified = held.map((call) => listEntry(
        call,
        call.qualified === true ? 'Good fit' : call.qualified === false ? 'Not a fit' : 'Not decided',
        call.call_at
    ));

    const proposalRows = proposals.map((call) => listEntry(call, 'Proposal sent', call.proposal_sent_on));

    const closeCalls = new Map();
    for (const call of [...proposals, ...won, ...lost]) closeCalls.set(String(call.id), call);
    const closes = [...closeCalls.values()].map((call) => {
        if (call.outcome === 'won' && won.includes(call)) return listEntry(call, 'Won', call.closed_on);
        if (call.outcome === 'lost' && lost.includes(call)) {
            return listEntry(call, `Lost${call.lost_reason ? ` · ${LOST_REASON_TEXT[call.lost_reason] || call.lost_reason}` : ''}`, call.closed_on);
        }
        return listEntry(call, 'Proposal sent, still open', call.proposal_sent_on);
    });

    return {
        callsBooked: callsBooked.sort(byDateDesc),
        showRate: showRate.sort(byDateDesc),
        qualified: qualified.sort(byDateDesc),
        proposals: proposalRows.sort(byDateDesc),
        closes: closes.sort(byDateDesc)
    };
}

/**
 * `bookedContactIds`: contacts Instantly marked "meeting booked" in the period;
 * merged with the sales log so calls booked = unique people who booked,
 * including anyone who later canceled.
 */
export function computeSalesMetrics(calls, { start, end, now = new Date(), positives = null, outreachCost = 0, bookedContactIds = [] }) {
    const nowTime = now.getTime();
    const todayTime = utcMidnight(now).getTime();
    const inPeriod = (value) => within(value, start, end);

    const bookedInPeriod = calls.filter((c) => inPeriod(c.booked_at));
    const bookedPeople = new Set(bookedInPeriod.map(personKey));
    const activePeople = new Set(bookedInPeriod.filter((c) => c.call_status !== 'canceled').map(personKey));
    const canceledPeople = [...bookedPeople].filter((key) => !activePeople.has(key)).length;
    // Instantly "meeting booked" contacts: ids, or { contact_id, name, email, company, booked_at }.
    const instantlyBooked = bookedContactIds.map((entry) => (
        entry && typeof entry === 'object' ? entry : { contact_id: entry }
    ));
    for (const entry of instantlyBooked) bookedPeople.add(`contact:${entry.contact_id}`);
    const callsBooked = bookedPeople.size;
    const callsDue = calls.filter((c) => inPeriod(c.call_at) && toTime(c.call_at) <= nowTime && c.call_status !== 'canceled');
    // A past call that wasn't canceled counts as held unless it was marked a
    // no-show (in Calendly, via the invitee_no_show webhook, or in the sales log).
    // Every sales card counts people, not sales-log rows: someone who booked
    // twice (two rows) counts once, so each rate matches its list.
    // A person counts as held if any of their past calls was held.
    const held = onePerPerson(
        callsDue.filter((c) => c.call_status === 'held' || c.call_status === 'booked'),
        (c) => c.call_at,
        (group) => ({
            // Good fit if any held call said so; not a fit if any said no; else undecided.
            qualified: group.some((c) => c.qualified === true) ? true
                : group.some((c) => c.qualified === false) ? false : null,
            call_status: group.some((c) => c.call_status === 'held') ? 'held' : 'booked'
        })
    );
    const heldKeys = new Set(held.map(personKey));
    const noShows = onePerPerson(callsDue.filter((c) => c.call_status === 'no_show'), (c) => c.call_at)
        .filter((c) => !heldKeys.has(personKey(c)));
    const assumedHeld = held.filter((c) => c.call_status === 'booked');
    const qualified = held.filter((c) => c.qualified === true);
    // Until a step has been recorded at least once, its rate is "not tracked" (null), not 0%.
    const tracksQualified = calls.some((c) => c.qualified !== null && c.qualified !== undefined);
    const tracksDeals = calls.some((c) => c.proposal_sent_on || c.outcome !== 'open');
    const proposals = onePerPerson(calls.filter((c) => inPeriod(c.proposal_sent_on)), (c) => c.proposal_sent_on);
    const won = onePerPerson(calls.filter((c) => c.outcome === 'won' && inPeriod(c.closed_on)), (c) => c.closed_on);
    const lost = onePerPerson(calls.filter((c) => c.outcome === 'lost' && inPeriod(c.closed_on)), (c) => c.closed_on)
        .filter((c) => !won.some((w) => personKey(w) === personKey(c)));

    const lists = buildSalesLists({
        bookedInPeriod, instantlyBooked, held, proposals, won, lost
    });

    const closeDurations = won
        .filter((c) => toTime(c.call_at) !== null)
        .map((c) => Math.max(0, (toTime(c.closed_on) - utcMidnight(new Date(c.call_at)).getTime()) / DAY_MS));

    const stalled = calls
        .filter((c) => c.outcome === 'open' && (c.call_status === 'held' || c.proposal_sent_on))
        .map((c) => {
            const lastTouch = Math.max(
                toTime(c.call_at) ?? 0,
                toTime(c.proposal_sent_on) ?? 0,
                toTime(c.last_contact_on) ?? 0
            );
            const followUp = toTime(c.next_follow_up_on);
            return { call: c, lastTouch, followUpScheduled: followUp !== null && followUp >= todayTime };
        })
        .filter(({ lastTouch, followUpScheduled }) => (
            lastTouch > 0 && nowTime - lastTouch >= STALLED_AFTER_DAYS * DAY_MS && !followUpScheduled
        ))
        .map(({ call, lastTouch }) => ({
            id: call.id,
            name: call.company || call.contact_name || call.contact_email,
            daysQuiet: Math.floor((nowTime - lastTouch) / DAY_MS)
        }))
        .sort((a, b) => b.daysQuiet - a.daysQuiet);

    const lostReasons = {};
    for (const call of lost) {
        const reason = call.lost_reason || 'unspecified';
        lostReasons[reason] = (lostReasons[reason] || 0) + 1;
    }

    // Money
    // Cash timing: a build fee counts when the deal closes; a retainer's first
    // month counts when the retainer starts (close date if no start is set).
    const retainerStartOf = (c) => c.retainer_start || c.closed_on;
    const retainersStarting = onePerPerson(
        calls.filter((c) => (
            c.outcome === 'won' && Number(c.retainer_monthly) > 0
            && inPeriod(retainerStartOf(c)) && toTime(retainerStartOf(c)) <= nowTime
        )),
        retainerStartOf
    );
    const buildRevenue = won.reduce((sum, c) => sum + (Number(c.build_value) || 0), 0);
    const retainerRevenue = retainersStarting.reduce((sum, c) => sum + (Number(c.retainer_monthly) || 0), 0);
    // 30-day cash: cash collected upfront. Build fees of deals closed in the
    // period, plus the first retainer month (paid upfront) of retainers that
    // started in the period. Later retainer months are not counted.
    const newRevenue = buildRevenue + retainerRevenue;
    const wonRetainers = won.map((c) => Number(c.retainer_monthly) || 0).filter((v) => v > 0);

    const retainerClients = calls.filter((c) => Number(c.retainer_monthly) > 0 && c.retainer_start);
    const startTime = start.getTime();
    const activeAtStart = retainerClients.filter((c) => (
        toTime(c.retainer_start) < startTime && (!c.retainer_end || toTime(c.retainer_end) >= startTime)
    ));
    const churned = retainerClients.filter((c) => c.retainer_end && inPeriod(c.retainer_end));
    const activeNow = retainerClients.filter((c) => (
        toTime(c.retainer_start) <= nowTime && (!c.retainer_end || toTime(c.retainer_end) >= todayTime)
    ));
    const periodDays = (end - start) / DAY_MS;
    const churnInPeriod = ratio(churned.length, activeAtStart.length);
    const monthlyChurn = churnInPeriod === null ? null : Math.min(1, churnInPeriod * DAYS_PER_MONTH / periodDays);
    const tenures = retainerClients.map((c) => (
        (Math.min(c.retainer_end ? toTime(c.retainer_end) : todayTime, todayTime) - toTime(c.retainer_start)) / DAY_MS / DAYS_PER_MONTH
    )).filter((months) => months >= 0);
    const avgTenureMonths = tenures.length ? tenures.reduce((a, b) => a + b, 0) / tenures.length : null;
    const avgRetainer = retainerClients.length
        ? retainerClients.reduce((sum, c) => sum + Number(c.retainer_monthly), 0) / retainerClients.length
        : null;
    const avgWonRetainer = wonRetainers.length ? wonRetainers.reduce((a, b) => a + b, 0) / wonRetainers.length : avgRetainer;
    const costPerClient = ratio(outreachCost, won.length);

    return {
        sales: {
            callsBooked,
            callsCanceled: canceledPeople,
            bookingRate: positives === null ? null : ratio(callsBooked, positives),
            callsDue: callsDue.length,
            callsHeld: held.length,
            noShows: noShows.length,
            callsAssumedHeld: assumedHeld.length,
            // People who canceled without rebooking count as not showing.
            showRate: ratio(held.length, held.length + noShows.length + canceledPeople),
            qualified: qualified.length,
            qualifiedRate: tracksQualified ? ratio(qualified.length, held.length) : null,
            proposalsSent: proposals.length,
            proposalRate: tracksDeals ? ratio(proposals.length, held.length) : null,
            dealsWon: won.length,
            dealsLost: lost.length,
            closeRate: tracksDeals ? ratio(won.length, proposals.length) : null,
            overallCloseRate: tracksDeals ? ratio(won.length, held.length) : null,
            avgDaysToClose: closeDurations.length ? round(closeDurations.reduce((a, b) => a + b, 0) / closeDurations.length) : null,
            stalledDeals: stalled,
            lostReasons,
            lists
        },
        money: {
            newRevenue: round(newRevenue, 2),
            buildRevenue: round(buildRevenue, 2),
            retainerRevenue: round(retainerRevenue, 2),
            // Reconciles with the card beside it: new cash collected ÷ deals won.
            avgDealValue: round(ratio(newRevenue, won.length), 2),
            outreachCost: round(outreachCost, 2),
            costPerBookedCall: round(ratio(outreachCost, callsBooked), 2),
            costPerProposal: round(ratio(outreachCost, proposals.length), 2),
            // Upfront cash (builds + first retainer month) ÷ marketing spend.
            roas: round(ratio(newRevenue, outreachCost), 2),
            costPerClient: round(costPerClient, 2),
            paybackMonths: costPerClient === null || !avgWonRetainer ? null : round(costPerClient / avgWonRetainer),
            activeRetainers: activeNow.length,
            mrr: round(activeNow.reduce((sum, c) => sum + Number(c.retainer_monthly), 0), 2),
            churnedInPeriod: churned.length,
            activeAtPeriodStart: activeAtStart.length,
            monthlyChurn,
            avgTenureMonths: round(avgTenureMonths),
            avgRetainer: round(avgRetainer, 2),
            lifetimeValue: avgTenureMonths === null || avgRetainer === null ? null : round(avgTenureMonths * avgRetainer, 2)
        }
    };
}

const instantlyCache = new Map();

/** Per-campaign totals from Instantly for [start, end) (Instantly's end_date is inclusive). */
async function loadInstantlyCampaignTotals(instantlyKey, start, end) {
    const key = `${instantlyKey.slice(-8)}:${isoDay(start)}:${isoDay(end)}`;
    const cached = instantlyCache.get(key);
    if (cached && Date.now() - cached.at < INSTANTLY_CACHE_TTL_MS) return cached.value;
    const params = new URLSearchParams({ start_date: isoDay(start), end_date: isoDay(addDays(end, -1)) });
    const rows = await instantlyRequest({ apiKey: instantlyKey, path: `/api/v2/campaigns/analytics?${params}` });
    const value = Array.isArray(rows) ? rows : [];
    instantlyCache.set(key, { at: Date.now(), value });
    return value;
}

async function loadPositivesByCampaign({ agencyId, sqlClientId, start, end }) {
    const { rows } = await pool.query(
        `WITH ${buildPositiveRepliesLifecycleCtesSql('$3::timestamptz')}
         SELECT (
                    SELECT e.campaign_id
                    FROM contact_instantly_events e
                    WHERE e.contact_id = qc.contact_id
                      AND e.client_id = $2
                      AND e.event_type = 'lead_interested'
                      AND e.event_timestamp = qc.interested_at
                    LIMIT 1
                ) AS campaign_id,
                COUNT(*)::int AS positives
         FROM qualified_contacts qc
         WHERE qc.interested_at < $4::timestamptz
         GROUP BY 1`,
        [agencyId, sqlClientId, start.toISOString(), end.toISOString()]
    );
    return rows;
}

async function loadCampaigns(agencyId, sqlClientId) {
    const { rows } = await pool.query(
        `SELECT id, instantly_campaign_id, name, status, start_date
         FROM instantly_campaigns
         WHERE agency_id = $1 AND client_id = $2`,
        [agencyId, sqlClientId]
    );
    return rows;
}

async function loadMeetingBookedContacts(agencyId, sqlClientId, start, end) {
    const { rows } = await pool.query(
        `SELECT DISTINCT ON (e.contact_id)
                e.contact_id, e.event_timestamp AS booked_at, c.full_name AS name,
                COALESCE(c.email, e.lead_email) AS email, co.domain_normalized AS company
         FROM contact_instantly_events e
         LEFT JOIN contacts c ON c.id = e.contact_id
         LEFT JOIN companies co ON co.id = c.company_id
         WHERE e.agency_id = $1 AND e.client_id = $2
           AND e.event_type = 'lead_meeting_booked'
           AND e.event_timestamp >= $3 AND e.event_timestamp < $4
           AND e.contact_id IS NOT NULL
         ORDER BY e.contact_id, e.event_timestamp ASC`,
        [agencyId, sqlClientId, start.toISOString(), end.toISOString()]
    );
    return rows;
}

async function loadEnrichmentSpend(agencyId, sqlClientId, start, end) {
    const { rows: [row] } = await pool.query(
        `SELECT COALESCE(SUM(jsc.amount), 0)::float8 AS amount
         FROM job_stage_costs jsc
         JOIN jobs j ON j.id = jsc.job_id
         WHERE j.agency_id = $1 AND j.client_id = $2
           AND j.created_at >= $3 AND j.created_at < $4`,
        [agencyId, sqlClientId, start.toISOString(), end.toISOString()]
    );
    return Number(row?.amount) || 0;
}

function settle(promise, warnings, label) {
    return promise.catch((error) => {
        warnings.push(`${label}: ${error?.message || error}`);
        return null;
    });
}

/**
 * Per-campaign rows: Instantly totals joined to our campaigns and positives.
 * Pure (exported for tests).
 */
export function buildScriptRows({ instantlyRows, campaigns, positivesRows, runwayCampaigns, now = new Date() }) {
    const byInstantlyId = new Map(campaigns.map((c) => [String(c.instantly_campaign_id), c]));
    const bySqlId = new Map(campaigns.map((c) => [String(c.id), c]));
    const positivesByInstantlyId = new Map();
    let unattributedPositives = 0;
    for (const row of positivesRows) {
        const campaign = row.campaign_id === null ? null : bySqlId.get(String(row.campaign_id));
        if (!campaign) {
            unattributedPositives += row.positives;
            continue;
        }
        const id = String(campaign.instantly_campaign_id);
        positivesByInstantlyId.set(id, (positivesByInstantlyId.get(id) || 0) + row.positives);
    }
    const runwayById = new Map((runwayCampaigns || []).map((c) => [String(c.id), c]));

    const ids = new Set([
        ...instantlyRows.map((r) => String(r.campaign_id)),
        ...positivesByInstantlyId.keys()
    ]);
    const scripts = [];
    for (const id of ids) {
        const analytics = instantlyRows.find((r) => String(r.campaign_id) === id) || {};
        const campaign = byInstantlyId.get(id);
        const runway = runwayById.get(id);
        const newContacts = Number(analytics.new_leads_contacted_count) || 0;
        const positives = positivesByInstantlyId.get(id) || 0;
        const active = Number(analytics.campaign_status ?? campaign?.status) === 1;
        const startedAt = toTime(campaign?.start_date);
        if (!active && newContacts === 0 && positives === 0 && !(Number(analytics.emails_sent_count) > 0)) continue;
        scripts.push({
            instantlyCampaignId: id,
            name: analytics.campaign_name || campaign?.name || 'Unknown campaign',
            active,
            daysLive: startedAt === null ? null : Math.max(0, Math.floor((now.getTime() - startedAt) / DAY_MS)),
            emailsSent: Number(analytics.emails_sent_count) || 0,
            newContacts,
            bounces: Number(analytics.bounced_count) || 0,
            positives,
            positiveRate: ratio(positives, newContacts),
            runwayDays: runway?.runwayDays ?? null,
            runsDryOn: runway?.runsDryOn ?? null
        });
    }
    scripts.sort((a, b) => Number(b.active) - Number(a.active) || b.newContacts - a.newContacts);
    return { scripts, unattributedPositives };
}

export async function loadFunnelMetrics({ clientRow, periodKey, now = new Date() }) {
    const agencyId = clientRow.agency_id;
    const sqlClientId = Number(clientRow.id);
    const instantlyKey = String(clientRow.instantly_key || '').trim();
    const period = resolvePeriod(periodKey, now);
    const { start, end } = period;
    const warnings = [];

    await settle(syncCalendlyBookings(clientRow), warnings, 'Calendly bookings');

    const [instantlyRows, runway, positivesRows, campaigns, calls, costRows, enrichmentSpend, bookedContactIds] = await Promise.all([
        instantlyKey
            ? settle(loadInstantlyCampaignTotals(instantlyKey, start, end), warnings, 'Instantly analytics')
            : Promise.resolve(null),
        instantlyKey
            ? settle(loadSendingRunway({ pool, agencyId, sqlClientId, instantlyKey }), warnings, 'Sending runway')
            : Promise.resolve(null),
        settle(loadPositivesByCampaign({ agencyId, sqlClientId, start, end }), warnings, 'Positive replies'),
        loadCampaigns(agencyId, sqlClientId),
        listSalesCalls(clientRow),
        listOutreachCosts(clientRow),
        settle(loadEnrichmentSpend(agencyId, sqlClientId, start, end), warnings, 'Enrichment spend'),
        settle(loadMeetingBookedContacts(agencyId, sqlClientId, start, end), warnings, 'Instantly meetings booked')
    ]);
    if (!instantlyKey) warnings.push('This client has no Instantly API key, so sending numbers are unavailable.');

    // Sending
    const instantlyTotals = (instantlyRows || []).reduce((acc, row) => ({
        emailsSent: acc.emailsSent + (Number(row.emails_sent_count) || 0),
        newContacts: acc.newContacts + (Number(row.new_leads_contacted_count) || 0),
        bounces: acc.bounces + (Number(row.bounced_count) || 0)
    }), { emailsSent: 0, newContacts: 0, bounces: 0 });
    // Today counts as a full working day, so capacity used reads low until sending finishes.
    const workingDaysElapsed = period.workingDays;
    const capacityPerDay = runway?.totals?.sendsPerDay ?? null;
    const plannedNewPerDay = runway?.totals?.newLeadsPerDay ?? null;
    const sending = instantlyRows === null ? null : {
        ...instantlyTotals,
        workingDays: workingDaysElapsed,
        newContactsPerWorkingDay: round(ratio(instantlyTotals.newContacts, workingDaysElapsed), 0),
        bounceRate: ratio(instantlyTotals.bounces, instantlyTotals.emailsSent),
        capacityPerDay,
        maxPossibleSends: capacityPerDay === null ? null : capacityPerDay * workingDaysElapsed,
        capacityUsed: capacityPerDay === null ? null : ratio(instantlyTotals.emailsSent, capacityPerDay * workingDaysElapsed),
        leadsQueued: runway?.totals?.backlog ?? null,
        plannedNewContactsPerDay: plannedNewPerDay,
        leadBufferDays: runway ? round(ratio(runway.totals.backlog, plannedNewPerDay)) : null,
        reserveVerified: runway?.totals?.reserve?.verified ?? null
    };

    // Replies
    const { scripts, unattributedPositives } = buildScriptRows({
        instantlyRows: instantlyRows || [],
        campaigns,
        positivesRows: positivesRows || [],
        runwayCampaigns: runway?.campaigns,
        now
    });
    const positives = positivesRows === null ? null : positivesRows.reduce((sum, row) => sum + row.positives, 0);
    const replies = {
        positives,
        newContacts: instantlyRows === null ? null : instantlyTotals.newContacts,
        positiveRate: positives === null || instantlyRows === null ? null : ratio(positives, instantlyTotals.newContacts),
        unattributedPositives,
        scripts
    };

    // Costs
    const costWindow = costWindowForPeriod(period);
    const costLines = costLinesForPeriod(costRows, costWindow.start, costWindow.end);
    const fixedCost = costLines.reduce((sum, line) => sum + line.amount, 0);
    if (costRows && !costRows.length) {
        warnings.push('No outreach costs are entered, so cost per call, cost per proposal, CAC and ROAS only count lead enrichment.');
    }
    const outreachCost = fixedCost + (enrichmentSpend || 0);

    const { sales, money } = computeSalesMetrics(calls, {
        start, end, now, positives, outreachCost, bookedContactIds: bookedContactIds || []
    });

    return {
        period: {
            key: period.key,
            label: period.label,
            start: isoDay(start),
            end: isoDay(addDays(end, -1)),
            days: period.days,
            workingDays: workingDaysElapsed
        },
        periods: Object.entries(METRIC_PERIODS).map(([key, label]) => ({ key, label })),
        sending,
        replies,
        sales,
        money: {
            ...money,
            costBreakdown: [
                ...costLines,
                { id: 'enrichment', label: 'Lead enrichment (jobs)', category: 'leads', automatic: true, amount: round(enrichmentSpend || 0, 2) }
            ]
        },
        warnings,
        computedAt: new Date().toISOString()
    };
}
