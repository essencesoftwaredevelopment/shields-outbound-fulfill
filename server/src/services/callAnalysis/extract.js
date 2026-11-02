/**
 * Call analysis: the model prompt + strict JSON schema, transcript formatting,
 * and the pure rules for turning one analysis into sales_calls updates.
 */

export const CALL_ANALYSIS_MODEL = String(process.env.CALL_ANALYSIS_MODEL || 'gpt-5.5').trim() || 'gpt-5.5';

const LOST_REASONS = ['price', 'timing', 'competitor', 'no_budget', 'ghosted', 'not_a_fit'];
const MAX_TRANSCRIPT_CHARS = 150_000;

export const CALL_ANALYSIS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: [
        'is_sales_conversation', 'call_type', 'summary', 'good_fit', 'good_fit_reason',
        'flow_build_discussed', 'retainer_discussed', 'build_price', 'retainer_monthly_price',
        'performance_fee', 'proposal_status', 'deal_status', 'lost_reason', 'next_step',
        'next_follow_up_date', 'objections'
    ],
    properties: {
        is_sales_conversation: { type: 'boolean' },
        call_type: { type: 'string', enum: ['discovery', 'follow_up', 'closing', 'onboarding_or_delivery', 'other'] },
        summary: { type: 'string' },
        good_fit: { type: ['boolean', 'null'] },
        good_fit_reason: { type: ['string', 'null'] },
        flow_build_discussed: { type: 'boolean' },
        retainer_discussed: { type: 'boolean' },
        build_price: { type: ['number', 'null'] },
        retainer_monthly_price: { type: ['number', 'null'] },
        performance_fee: { type: ['string', 'null'] },
        proposal_status: { type: 'string', enum: ['none', 'promised', 'sent'] },
        deal_status: { type: 'string', enum: ['open', 'won', 'lost'] },
        lost_reason: { anyOf: [{ type: 'string', enum: LOST_REASONS }, { type: 'null' }] },
        next_step: { type: ['string', 'null'] },
        next_follow_up_date: { type: ['string', 'null'] },
        objections: { type: 'array', items: { type: 'string' } }
    }
};

export const CALL_ANALYSIS_INSTRUCTIONS = `You analyse recorded sales calls for ESSENCE, an email marketing (Klaviyo) agency that sells
(a) one-time flow builds and (b) monthly retainers, sometimes with a performance fee.
You get the meeting title, date, attendees and transcript (and sometimes Fathom's own summary).
Return JSON only, following the schema. Be factual: use only what was said on this call. When unsure, use null.

Fields:
- is_sales_conversation: true when ESSENCE is selling to, negotiating with or closing this prospect. false for internal
  meetings, delivery/onboarding work with an existing client, or unrelated calls.
- call_type: discovery (first sales call), follow_up (later sales call), closing (terms agreed / signing),
  onboarding_or_delivery (already a client), other.
- summary: 2–3 plain sentences a salesperson can skim: their situation, what was offered, where it stands.
- good_fit: is this prospect a good fit for ESSENCE's services (real store, revenue/list size worth working on, need
  ESSENCE can fill, can afford it)? null if the call gives no basis. good_fit_reason: one short sentence.
- flow_build_discussed / retainer_discussed: was that service discussed.
- build_price: the one-time flow build price quoted or agreed, in USD. If a range was quoted, use the midpoint.
  null if none was quoted.
- retainer_monthly_price: the monthly retainer quoted or agreed, in USD (midpoint of a range). null if none.
- performance_fee: any performance/commission component in words (e.g. "8% of Klaviyo-attributed revenue"), else null.
- proposal_status: sent = a proposal/agreement/contract has already been sent to them (as of this call);
  promised = ESSENCE committed on this call to send one; none otherwise.
- deal_status: won = the prospect clearly agreed to go ahead (terms accepted, signing, onboarding or payment being
  arranged); lost = they clearly declined or chose someone else; open otherwise.
- lost_reason: only when deal_status is lost — one of price, timing, competitor, no_budget, ghosted, not_a_fit.
- next_step: the agreed next step in one short sentence, or null.
- next_follow_up_date: YYYY-MM-DD only when a specific day for the next call/follow-up was agreed. Resolve relative
  dates ("next Tuesday") against the meeting date. null otherwise.
- objections: up to 5 short phrases for concerns or objections the prospect raised.`;

/** Plain-text transcript with prospect / ESSENCE labels, capped for the model. */
export function formatTranscript(transcript, invitees = []) {
    const external = new Set(
        (invitees || []).filter((i) => i?.is_external && i?.email).map((i) => String(i.email).toLowerCase())
    );
    const lines = (Array.isArray(transcript) ? transcript : []).map((item) => {
        const name = item?.speaker?.display_name || 'Unknown';
        const email = String(item?.speaker?.matched_calendar_invitee_email || '').toLowerCase();
        const side = email ? (external.has(email) ? ' (prospect)' : ' (ESSENCE)') : '';
        return `[${item?.timestamp || ''}] ${name}${side}: ${String(item?.text || '').trim()}`;
    });
    const text = lines.join('\n');
    return text.length > MAX_TRANSCRIPT_CHARS ? `${text.slice(0, MAX_TRANSCRIPT_CHARS)}\n[transcript truncated]` : text;
}

export function buildAnalysisInput(recording) {
    const invitees = Array.isArray(recording.invitees) ? recording.invitees : [];
    return [
        `Meeting title: ${recording.title || 'Untitled'}`,
        `Meeting date: ${recording.recorded_at ? new Date(recording.recorded_at).toISOString().slice(0, 10) : 'unknown'}`,
        `Attendees: ${invitees.map((i) => `${i.name || i.email || 'unknown'}${i.is_external ? ' (external)' : ' (ESSENCE)'}`).join(', ') || 'unknown'}`,
        recording.provider_summary ? `Fathom summary:\n${recording.provider_summary}` : '',
        `Transcript:\n${recording.transcript || '(no transcript)'}`
    ].filter(Boolean).join('\n\n');
}

/** Normalizes the model's JSON so downstream code can trust the shape. */
export function normalizeAnalysis(raw) {
    const a = raw && typeof raw === 'object' ? raw : {};
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null);
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);
    const dealStatus = ['open', 'won', 'lost'].includes(a.deal_status) ? a.deal_status : 'open';
    return {
        is_sales_conversation: a.is_sales_conversation === true,
        call_type: str(a.call_type) || 'other',
        summary: str(a.summary) || '',
        good_fit: typeof a.good_fit === 'boolean' ? a.good_fit : null,
        good_fit_reason: str(a.good_fit_reason),
        flow_build_discussed: a.flow_build_discussed === true,
        retainer_discussed: a.retainer_discussed === true,
        build_price: num(a.build_price),
        retainer_monthly_price: num(a.retainer_monthly_price),
        performance_fee: str(a.performance_fee),
        proposal_status: ['none', 'promised', 'sent'].includes(a.proposal_status) ? a.proposal_status : 'none',
        deal_status: dealStatus,
        lost_reason: dealStatus === 'lost' && LOST_REASONS.includes(a.lost_reason) ? a.lost_reason : null,
        next_step: str(a.next_step),
        next_follow_up_date: date(a.next_follow_up_date),
        objections: Array.isArray(a.objections) ? a.objections.map(str).filter(Boolean).slice(0, 5) : []
    };
}

const DEFAULTS = { call_status: 'booked', outcome: 'open' };

function isEmpty(call, field) {
    const value = call[field];
    if (value === null || value === undefined || value === '') return true;
    return Object.prototype.hasOwnProperty.call(DEFAULTS, field) && value === DEFAULTS[field];
}

function isoDay(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * What one analysed recording changes on its sales call.
 *
 * A field is written when it's empty (or still at its default), or when the AI
 * wrote it before and the user hasn't edited it since (ai_filled_fields). When
 * the recording is older than the newest one already applied, it only fills
 * empty fields, so backfill order can't roll a deal backwards.
 *
 * @returns {{ changes: Record<string, any>, filledFields: string[] }}
 */
export function planSalesCallUpdate(call, analysis, recording) {
    const aiOwned = new Set(call.ai_filled_fields || []);
    const recordedAt = recording.recorded_at ? new Date(recording.recorded_at) : null;
    const newest = !call.ai_source_recorded_at || !recordedAt
        || recordedAt.getTime() >= new Date(call.ai_source_recorded_at).getTime();
    const day = isoDay(recordedAt);
    const changes = {};
    const filled = new Set();

    const write = (field, value) => {
        if (value === null || value === undefined) return;
        if (!(isEmpty(call, field) || (newest && aiOwned.has(field)))) return;
        if (call[field] === value) return;
        changes[field] = value;
        filled.add(field);
    };

    // A recording with the prospect proves a call happened.
    if (call.call_status === 'booked' || (call.call_status === 'no_show' && aiOwned.has('call_status'))) {
        changes.call_status = 'held';
        filled.add('call_status');
    }
    if (!call.call_at && recordedAt) {
        changes.call_at = recordedAt.toISOString();
        filled.add('call_at');
    }
    if (day && (!call.last_contact_on || String(call.last_contact_on) < day)) {
        changes.last_contact_on = day;
        filled.add('last_contact_on');
    }

    if (!analysis.is_sales_conversation) {
        return { changes, filledFields: [...filled] };
    }

    write('qualified', analysis.good_fit);
    write('build_value', analysis.build_price);
    write('retainer_monthly', analysis.retainer_monthly_price);
    if (analysis.proposal_status === 'sent' || analysis.deal_status === 'won') write('proposal_sent_on', day);
    if (analysis.deal_status === 'won' || analysis.deal_status === 'lost') {
        write('outcome', analysis.deal_status);
        if ('outcome' in changes) {
            // The close date and reason belong to the outcome the AI just set.
            changes.closed_on = day;
            filled.add('closed_on');
            if (analysis.deal_status === 'lost') {
                changes.lost_reason = analysis.lost_reason;
                filled.add('lost_reason');
            } else if (call.lost_reason) {
                changes.lost_reason = null;
            }
            if (analysis.deal_status === 'won' && (changes.retainer_monthly ?? call.retainer_monthly) > 0 && isEmpty(call, 'retainer_start')) {
                changes.retainer_start = day;
                filled.add('retainer_start');
            }
        }
    }
    if (analysis.next_follow_up_date && (!day || analysis.next_follow_up_date >= day)) {
        write('next_follow_up_on', analysis.next_follow_up_date);
    }

    return { changes, filledFields: [...filled] };
}
