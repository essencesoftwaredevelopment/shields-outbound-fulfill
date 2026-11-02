/**
 * Manual inputs for the Metrics tab (migration 0075): the sales log
 * (sales_calls) and recurring outreach cost lines (outreach_costs).
 *
 * Every query is scoped by agency_id + client_id. Calendly bookings for the
 * client are copied into the sales log on read (syncCalendlyBookings), so a
 * booked call only needs its outcome filled in.
 */
import { pool } from '../../config/db.js';

export const CALL_STATUSES = ['booked', 'held', 'no_show', 'canceled'];
export const OUTCOMES = ['open', 'won', 'lost'];
export const LOST_REASONS = ['price', 'timing', 'competitor', 'no_budget', 'ghosted', 'not_a_fit'];
export const COST_CATEGORIES = ['inboxes', 'domains', 'tools', 'leads', 'other'];

function badRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    return error;
}

function text(value, field, max = 500) {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    if (trimmed.length > max) throw badRequest(`${field} is too long.`);
    return trimmed || null;
}

function date(value, field) {
    if (value === null || value === undefined || value === '') return null;
    const raw = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
        throw badRequest(`${field} must be a date (YYYY-MM-DD).`);
    }
    return raw;
}

function timestamp(value, field) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = new Date(String(value));
    if (Number.isNaN(parsed.getTime())) throw badRequest(`${field} must be a date and time.`);
    return parsed.toISOString();
}

function money(value, field) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw badRequest(`${field} must be a positive number.`);
    return Math.round(n * 100) / 100;
}

function oneOf(value, allowed, field, { nullable = false } = {}) {
    if ((value === null || value === undefined || value === '') && nullable) return null;
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!allowed.includes(normalized)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}.`);
    return normalized;
}

function bool(value) {
    if (value === null || value === undefined || value === '') return null;
    return value === true || value === 'true';
}

const SALES_CALL_FIELDS = {
    company: (v) => text(v, 'Company', 200),
    contact_name: (v) => text(v, 'Contact name', 200),
    contact_email: (v) => text(v, 'Contact email', 320),
    booked_at: (v) => timestamp(v, 'Booked at'),
    call_at: (v) => timestamp(v, 'Call time'),
    call_status: (v) => oneOf(v, CALL_STATUSES, 'Call status'),
    qualified: (v) => bool(v),
    proposal_sent_on: (v) => date(v, 'Proposal sent'),
    outcome: (v) => oneOf(v, OUTCOMES, 'Outcome'),
    closed_on: (v) => date(v, 'Closed on'),
    lost_reason: (v) => oneOf(v, LOST_REASONS, 'Lost reason', { nullable: true }),
    build_value: (v) => money(v, 'Flow build value'),
    retainer_monthly: (v) => money(v, 'Monthly retainer'),
    retainer_start: (v) => date(v, 'Retainer start'),
    retainer_end: (v) => date(v, 'Retainer end'),
    last_contact_on: (v) => date(v, 'Last contact'),
    next_follow_up_on: (v) => date(v, 'Next follow-up'),
    notes: (v) => text(v, 'Notes', 5000)
};

const COST_FIELDS = {
    label: (v) => text(v, 'Label', 200),
    category: (v) => oneOf(v, COST_CATEGORIES, 'Category'),
    monthly_amount: (v) => money(v, 'Monthly amount'),
    starts_on: (v) => date(v, 'Starts on'),
    ends_on: (v) => date(v, 'Ends on')
};

const SALES_CALL_DATE_COLUMNS = ['proposal_sent_on', 'closed_on', 'retainer_start', 'retainer_end', 'last_contact_on', 'next_follow_up_on'];

// DATE columns come back as text so no timezone can shift them; NUMERIC as numbers.
export const SALES_CALL_SELECT = `
    id, agency_id, client_id, contact_id, calendly_booking_id, company, contact_name,
    contact_email, booked_at, call_at, call_status, qualified,
    ${SALES_CALL_DATE_COLUMNS.map((key) => `${key}::text AS ${key}`).join(', ')},
    outcome, lost_reason, build_value::float8 AS build_value,
    retainer_monthly::float8 AS retainer_monthly, notes, created_at, updated_at,
    ai_filled_fields, ai_summary, ai_updated_at, ai_source_recorded_at, recording_url`;

const COST_SELECT = `
    id, agency_id, client_id, label, category, monthly_amount::float8 AS monthly_amount,
    starts_on::text AS starts_on, ends_on::text AS ends_on, created_at, updated_at`;

/** Equality across the shapes a field arrives in (Date vs ISO string, number vs string). */
function sameValue(a, b) {
    if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '';
    if (b === null || b === undefined || b === '') return false;
    if (a instanceof Date || b instanceof Date) {
        const ta = new Date(a).getTime();
        const tb = new Date(b).getTime();
        // datetime-local inputs drop seconds
        return Math.abs(ta - tb) < 60_000;
    }
    if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
    return String(a) === String(b);
}

function pickFields(input, spec) {
    const values = {};
    for (const [key, parse] of Object.entries(spec)) {
        if (Object.prototype.hasOwnProperty.call(input || {}, key)) values[key] = parse(input[key]);
    }
    return values;
}

function todayIso() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Keeps a sales call internally consistent after an edit: a closed deal gets a
 * close date, only lost deals keep a lost reason, and an open deal has neither.
 */
export function normalizeSalesCall(merged) {
    const next = { ...merged };
    if (next.outcome === 'won' || next.outcome === 'lost') {
        if (!next.closed_on) next.closed_on = todayIso();
    } else {
        next.closed_on = null;
    }
    if (next.outcome !== 'lost') next.lost_reason = null;
    if (next.outcome === 'won' && next.retainer_monthly > 0 && !next.retainer_start) {
        next.retainer_start = next.closed_on;
    }
    if (next.retainer_end && next.retainer_start && next.retainer_end < next.retainer_start) {
        throw badRequest('Retainer end must be on or after the retainer start.');
    }
    return next;
}

/** Copies the client's Calendly bookings into the sales log and mirrors cancellations. */
export async function syncCalendlyBookings(clientRow, db = pool) {
    await db.query(
        `INSERT INTO sales_calls (
             agency_id, client_id, contact_id, calendly_booking_id, company,
             contact_name, contact_email, booked_at, call_at, call_status
         )
         SELECT $1, $2, b.contact_id, b.id, co.domain_normalized,
                NULLIF(TRIM(b.invitee_name), ''), NULLIF(TRIM(b.invitee_email), ''),
                CASE WHEN COALESCE(b.raw_invitee->>'created_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
                     THEN (b.raw_invitee->>'created_at')::timestamptz
                     ELSE b.created_at END,
                b.start_time,
                CASE WHEN b.status = 'canceled' THEN 'canceled' ELSE 'booked' END
         FROM calendly_bookings b
         LEFT JOIN contacts c ON c.id = b.contact_id
         LEFT JOIN companies co ON co.id = c.company_id
         WHERE b.client_id = $2 AND b.agency_id = $1
         ON CONFLICT (calendly_booking_id) DO NOTHING`,
        [clientRow.agency_id, clientRow.id]
    );
    await db.query(
        `UPDATE sales_calls s
         SET call_status = 'canceled', updated_at = NOW()
         FROM calendly_bookings b
         WHERE s.calendly_booking_id = b.id
           AND s.client_id = $2 AND s.agency_id = $1
           AND b.status = 'canceled'
           AND s.call_status = 'booked'`,
        [clientRow.agency_id, clientRow.id]
    );
}

/**
 * Calendly no-show webhook (invitee_no_show.created / .deleted): marks the
 * booking's sales call as a no-show, or back to booked when the mark is undone.
 * Syncs the client's bookings first so a call not copied yet isn't missed.
 */
export async function applyCalendlyNoShow({ inviteeUri, noShow }, db = pool) {
    const { rows: [booking] } = await db.query(
        `SELECT id, agency_id, client_id FROM calendly_bookings
         WHERE invitee_uri = $1
         ORDER BY updated_at DESC NULLS LAST
         LIMIT 1`,
        [inviteeUri]
    );
    if (!booking) return { updated: 0, reason: 'booking_not_found' };
    if (!booking.client_id) return { updated: 0, reason: 'booking_has_no_client' };
    await syncCalendlyBookings({ agency_id: booking.agency_id, id: booking.client_id }, db);
    const { rowCount } = await db.query(
        noShow
            ? `UPDATE sales_calls SET call_status = 'no_show', updated_at = NOW()
               WHERE calendly_booking_id = $1 AND call_status IN ('booked', 'held')`
            : `UPDATE sales_calls SET call_status = 'booked', updated_at = NOW()
               WHERE calendly_booking_id = $1 AND call_status = 'no_show'`,
        [booking.id]
    );
    return { updated: rowCount };
}

export async function listSalesCalls(clientRow, db = pool) {
    const { rows } = await db.query(
        `SELECT ${SALES_CALL_SELECT} FROM sales_calls
         WHERE agency_id = $1 AND client_id = $2
         ORDER BY COALESCE(call_at, booked_at, created_at) DESC, id DESC`,
        [clientRow.agency_id, clientRow.id]
    );
    return rows;
}

async function getSalesCall(clientRow, id, db = pool) {
    const { rows: [row] } = await db.query(
        `SELECT ${SALES_CALL_SELECT} FROM sales_calls WHERE agency_id = $1 AND client_id = $2 AND id = $3`,
        [clientRow.agency_id, clientRow.id, id]
    );
    return row || null;
}

export async function createSalesCall(clientRow, input) {
    const values = normalizeSalesCall({
        call_status: 'booked',
        outcome: 'open',
        ...pickFields(input, SALES_CALL_FIELDS)
    });
    if (!values.company && !values.contact_name && !values.contact_email) {
        throw badRequest('Add a company, name or email.');
    }
    const columns = Object.keys(values);
    const { rows: [row] } = await pool.query(
        `INSERT INTO sales_calls (agency_id, client_id, ${columns.join(', ')})
         VALUES ($1, $2, ${columns.map((_, i) => `$${i + 3}`).join(', ')})
         RETURNING ${SALES_CALL_SELECT}`,
        [clientRow.agency_id, clientRow.id, ...columns.map((key) => values[key])]
    );
    return row;
}

export async function updateSalesCall(clientRow, id, input) {
    const existing = await getSalesCall(clientRow, id);
    if (!existing) return null;
    const changes = pickFields(input, SALES_CALL_FIELDS);
    const merged = normalizeSalesCall({ ...existing, ...changes });
    const columns = Object.keys(SALES_CALL_FIELDS);
    // A field the user changed by hand is theirs from now on: the call analysis
    // (services/callAnalysis) won't overwrite it again.
    const editedFields = columns.filter((key) => !sameValue(existing[key], merged[key] ?? null));
    const aiFilledFields = (existing.ai_filled_fields || []).filter((key) => !editedFields.includes(key));
    const { rows: [row] } = await pool.query(
        `UPDATE sales_calls
         SET ${columns.map((key, i) => `${key} = $${i + 5}`).join(', ')}, ai_filled_fields = $4, updated_at = NOW()
         WHERE agency_id = $1 AND client_id = $2 AND id = $3
         RETURNING ${SALES_CALL_SELECT}`,
        [clientRow.agency_id, clientRow.id, id, aiFilledFields, ...columns.map((key) => merged[key] ?? null)]
    );
    return row || null;
}

export async function deleteSalesCall(clientRow, id) {
    const { rowCount } = await pool.query(
        'DELETE FROM sales_calls WHERE agency_id = $1 AND client_id = $2 AND id = $3',
        [clientRow.agency_id, clientRow.id, id]
    );
    return rowCount > 0;
}

export async function listOutreachCosts(clientRow, db = pool) {
    const { rows } = await db.query(
        `SELECT ${COST_SELECT} FROM outreach_costs
         WHERE agency_id = $1 AND client_id = $2
         ORDER BY ends_on IS NOT NULL, category, label, id`,
        [clientRow.agency_id, clientRow.id]
    );
    return rows;
}

function validateCost(values) {
    if (!values.label) throw badRequest('Label is required.');
    if (values.monthly_amount === null || values.monthly_amount === undefined) throw badRequest('Monthly amount is required.');
    if (values.ends_on && values.starts_on && values.ends_on < values.starts_on) {
        throw badRequest('End date must be on or after the start date.');
    }
}

export async function createOutreachCost(clientRow, input) {
    const values = { category: 'other', starts_on: todayIso(), ...pickFields(input, COST_FIELDS) };
    if (!values.starts_on) values.starts_on = todayIso();
    validateCost(values);
    const columns = Object.keys(values);
    const { rows: [row] } = await pool.query(
        `INSERT INTO outreach_costs (agency_id, client_id, ${columns.join(', ')})
         VALUES ($1, $2, ${columns.map((_, i) => `$${i + 3}`).join(', ')})
         RETURNING ${COST_SELECT}`,
        [clientRow.agency_id, clientRow.id, ...columns.map((key) => values[key])]
    );
    return row;
}

export async function updateOutreachCost(clientRow, id, input) {
    const { rows: [existing] } = await pool.query(
        `SELECT ${COST_SELECT} FROM outreach_costs WHERE agency_id = $1 AND client_id = $2 AND id = $3`,
        [clientRow.agency_id, clientRow.id, id]
    );
    if (!existing) return null;
    const merged = {
        label: existing.label,
        category: existing.category,
        monthly_amount: existing.monthly_amount,
        starts_on: existing.starts_on,
        ends_on: existing.ends_on,
        ...pickFields(input, COST_FIELDS)
    };
    if (!merged.starts_on) merged.starts_on = todayIso();
    validateCost(merged);
    const columns = Object.keys(COST_FIELDS);
    const { rows: [row] } = await pool.query(
        `UPDATE outreach_costs
         SET ${columns.map((key, i) => `${key} = $${i + 4}`).join(', ')}, updated_at = NOW()
         WHERE agency_id = $1 AND client_id = $2 AND id = $3
         RETURNING ${COST_SELECT}`,
        [clientRow.agency_id, clientRow.id, id, ...columns.map((key) => merged[key])]
    );
    return row || null;
}

export async function deleteOutreachCost(clientRow, id) {
    const { rowCount } = await pool.query(
        'DELETE FROM outreach_costs WHERE agency_id = $1 AND client_id = $2 AND id = $3',
        [clientRow.agency_id, clientRow.id, id]
    );
    return rowCount > 0;
}
