/**
 * Fathom recordings → sales log. One call_recordings row per recording moves
 * received → matched | unmatched → analyzed → applied (or failed).
 *
 * The steps are idempotent and called one by one from the call-analysis
 * Vercel Workflow (workflows/call-analysis.ts), or inline when workflows
 * aren't configured (local dev). See migration 0076.
 */
import { OpenAI } from 'openai';
import { pool } from '../../config/db.js';
import { getAgencySettings, apiKeysFromSettings, agencyFeaturesFromSettings } from '../db/agencySettings.js';
import { SALES_CALL_SELECT } from '../db/funnelInputs.js';
import { resolveWorkflowStartBaseUrl } from '../interestedResearch/trigger.js';
import {
    createFathomWebhook,
    deleteFathomWebhook,
    listFathomMeetings,
    normalizeFathomUrl
} from '../fathom.js';
import {
    CALL_ANALYSIS_INSTRUCTIONS,
    CALL_ANALYSIS_MODEL,
    CALL_ANALYSIS_SCHEMA,
    buildAnalysisInput,
    formatTranscript,
    normalizeAnalysis,
    planSalesCallUpdate
} from './extract.js';

const FREE_EMAIL_DOMAINS = new Set([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'live.nl', 'msn.com', 'yahoo.com',
    'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'hey.com'
]);

const POSITIVE_EVENT_TYPES = ['lead_interested', 'lead_meeting_booked', 'interested_reply_sent'];

function notFound(message) {
    const error = new Error(message);
    error.statusCode = 404;
    return error;
}

async function loadRecording(recordingId, agencyId, db = pool) {
    const { rows: [row] } = await db.query(
        'SELECT * FROM call_recordings WHERE id = $1 AND agency_id = $2',
        [recordingId, agencyId]
    );
    if (!row) throw notFound(`call recording ${recordingId} not found`);
    return row;
}

async function setRecording(recordingId, agencyId, fields, db = pool) {
    const keys = Object.keys(fields);
    await db.query(
        `UPDATE call_recordings
         SET ${keys.map((key, i) => `${key} = $${i + 3}`).join(', ')}, updated_at = NOW()
         WHERE id = $1 AND agency_id = $2`,
        [recordingId, agencyId, ...keys.map((key) => fields[key])]
    );
}

/**
 * A recording that belongs to no prospect (team meeting, client call, partner)
 * keeps only its title, date and attendees: the transcript and summary are
 * dropped so non-sales conversations aren't stored.
 */
async function markUnmatched(recordingId, agencyId, reason, db = pool) {
    await setRecording(recordingId, agencyId, {
        status: 'unmatched',
        match_reason: reason,
        transcript: null,
        provider_summary: null,
        analysis: null,
        sales_call_id: null
    }, db);
}

/** The latest positive reply (Instantly) from one of these emails, if any. */
async function findPositiveReplyLead(agencyId, emails, db = pool) {
    const { rows: [lead] } = await db.query(
        `SELECT e.client_id, e.contact_id, e.lead_email, c.full_name, co.domain_normalized
         FROM contact_instantly_events e
         LEFT JOIN contacts c ON c.id = e.contact_id
         LEFT JOIN companies co ON co.id = c.company_id
         WHERE e.agency_id = $1
           AND e.lead_email = ANY($2::text[])
           AND e.event_type = ANY($3::text[])
         ORDER BY e.event_timestamp DESC
         LIMIT 1`,
        [agencyId, emails, POSITIVE_EVENT_TYPES]
    );
    return lead || null;
}

/** External attendee emails, lowercased, from Fathom calendar invitees. */
export function externalEmails(invitees) {
    return [...new Set((invitees || [])
        .filter((i) => i?.is_external && typeof i?.email === 'string' && i.email.includes('@'))
        .map((i) => i.email.trim().toLowerCase()))];
}

export function parseDomainList(value) {
    return String(value || '')
        .split(/[,\s]+/)
        .map((d) => d.trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
        .filter(Boolean);
}

/**
 * Email domains that belong to the agency's own team: the recorder's domain,
 * any domain Fathom ever marked internal, and features.callAnalysisInternalDomains.
 * Fathom only treats the recorder's domain as internal, so a second company
 * domain (e.g. essenceretention.com) would otherwise look like a prospect.
 */
async function loadOwnDomains(agencyId, db = pool) {
    const [{ rows }, settings] = await Promise.all([
        db.query(
            `SELECT DISTINCT d FROM (
                 SELECT SPLIT_PART(LOWER(recorded_by_email), '@', 2) AS d
                 FROM call_recordings WHERE agency_id = $1 AND recorded_by_email IS NOT NULL
                 UNION
                 SELECT SPLIT_PART(LOWER(inv->>'email'), '@', 2)
                 FROM call_recordings r, JSONB_ARRAY_ELEMENTS(r.invitees) inv
                 WHERE r.agency_id = $1 AND (inv->>'is_external') = 'false'
             ) x WHERE d <> ''`,
            [agencyId]
        ),
        getAgencySettings(agencyId)
    ]);
    const configured = parseDomainList(agencyFeaturesFromSettings(settings).callAnalysisInternalDomains?.domains);
    return new Set([...rows.map((row) => row.d), ...configured]);
}

export function businessDomains(emails) {
    return [...new Set(emails
        .map((email) => email.split('@')[1])
        .filter((domain) => domain && !FREE_EMAIL_DOMAINS.has(domain)))];
}

/**
 * Stores (or refreshes) a Fathom meeting. Returns the row id and whether it
 * still needs analysis; a recording already applied or unmatched isn't redone.
 */
export async function ingestFathomMeeting(agencyId, meeting) {
    const externalId = String(meeting?.recording_id ?? '').trim();
    if (!externalId) throw new Error('Fathom meeting has no recording_id');
    const invitees = Array.isArray(meeting.calendar_invitees) ? meeting.calendar_invitees : [];
    const { rows: [row] } = await pool.query(
        `INSERT INTO call_recordings (
             agency_id, provider, external_id, title, url, share_url, recorded_at, recording_end_at,
             recorded_by_email, external_emails, invitees, transcript, provider_summary
         ) VALUES ($1, 'fathom', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
         ON CONFLICT (agency_id, provider, external_id) DO UPDATE SET
             title = EXCLUDED.title,
             url = EXCLUDED.url,
             share_url = EXCLUDED.share_url,
             -- an unmatched (non-sales) recording never gets its transcript back
             transcript = CASE WHEN call_recordings.status = 'unmatched' THEN NULL
                               ELSE COALESCE(EXCLUDED.transcript, call_recordings.transcript) END,
             provider_summary = CASE WHEN call_recordings.status = 'unmatched' THEN NULL
                                     ELSE COALESCE(EXCLUDED.provider_summary, call_recordings.provider_summary) END,
             updated_at = NOW()
         RETURNING id, status`,
        [
            agencyId,
            externalId,
            meeting.meeting_title || meeting.title || null,
            meeting.url || null,
            meeting.share_url || null,
            meeting.recording_start_time || meeting.scheduled_start_time || meeting.created_at || null,
            meeting.recording_end_time || null,
            meeting.recorded_by?.email || null,
            externalEmails(invitees),
            JSON.stringify(invitees),
            Array.isArray(meeting.transcript) && meeting.transcript.length ? formatTranscript(meeting.transcript, invitees) : null,
            meeting.default_summary?.markdown_formatted || null
        ]
    );
    return { recordingId: Number(row.id), needsAnalysis: ['received', 'matched', 'analyzed', 'failed'].includes(row.status) };
}

/** Step 1: find the sales call this recording belongs to. */
export async function matchRecording({ recordingId, agencyId }) {
    const recording = await loadRecording(recordingId, agencyId);
    if (recording.sales_call_id) return { status: 'matched', salesCallId: Number(recording.sales_call_id) };

    const ownDomains = await loadOwnDomains(agencyId);
    const emails = (recording.external_emails || []).filter((email) => !ownDomains.has(email.split('@')[1]));
    if (!emails.length) {
        await markUnmatched(recordingId, agencyId, 'no_external_attendees');
        return { status: 'unmatched' };
    }

    // 1. A sales call with this person (email on the call, or its contact).
    const { rows: byEmail } = await pool.query(
        `SELECT s.id, s.client_id
         FROM sales_calls s
         LEFT JOIN contacts c ON c.id = s.contact_id
         WHERE s.agency_id = $1
           AND (LOWER(s.contact_email) = ANY($2::text[]) OR LOWER(c.email) = ANY($2::text[]))
         ORDER BY (s.call_status = 'canceled'), ABS(EXTRACT(EPOCH FROM (COALESCE(s.call_at, s.booked_at, s.created_at) - $3::timestamptz)))
         LIMIT 1`,
        [agencyId, emails, recording.recorded_at || new Date().toISOString()]
    );
    let match = byEmail[0] ? { ...byEmail[0], reason: 'email' } : null;

    // 2. Same company domain (skips gmail and other free mailboxes).
    const domains = businessDomains(emails);
    if (!match && domains.length) {
        const { rows } = await pool.query(
            `SELECT id, client_id FROM sales_calls
             WHERE agency_id = $1 AND LOWER(company) = ANY($2::text[])
             ORDER BY (call_status = 'canceled'), ABS(EXTRACT(EPOCH FROM (COALESCE(call_at, booked_at, created_at) - $3::timestamptz)))
             LIMIT 1`,
            [agencyId, domains, recording.recorded_at || new Date().toISOString()]
        );
        if (rows[0]) match = { ...rows[0], reason: 'domain' };
    }

    // 3. A lead who replied positively but booked outside Calendly. The sales
    //    call is only created after the analysis confirms a sales conversation
    //    (applyRecordingAnalysis), so a delivery call with an existing client
    //    never shows up as a new booked call.
    if (!match) {
        const lead = await findPositiveReplyLead(agencyId, emails);
        if (lead) {
            await setRecording(recordingId, agencyId, {
                status: 'matched',
                match_reason: 'positive_reply',
                client_id: lead.client_id
            });
            return { status: 'matched', salesCallId: null };
        }
    }

    if (!match) {
        await markUnmatched(recordingId, agencyId, 'no_prospect_match');
        return { status: 'unmatched' };
    }
    await setRecording(recordingId, agencyId, {
        status: 'matched',
        match_reason: match.reason,
        sales_call_id: match.id,
        client_id: match.client_id
    });
    return { status: 'matched', salesCallId: Number(match.id) };
}

/** Step 2: one model call on the transcript. */
export async function analyzeRecording({ recordingId, agencyId }) {
    const recording = await loadRecording(recordingId, agencyId);
    if (recording.analysis && ['analyzed', 'applied'].includes(recording.status)) {
        return { status: 'analyzed', cached: true };
    }
    if (!recording.transcript) {
        throw new Error('Recording has no transcript yet');
    }
    const settings = await getAgencySettings(agencyId);
    const openaiKey = apiKeysFromSettings(settings).openai || process.env.OPENAI_API_KEY || '';
    if (!openaiKey) throw new Error('missing_openai_key');

    const openai = new OpenAI({ apiKey: openaiKey });
    const response = await openai.responses.create({
        model: CALL_ANALYSIS_MODEL,
        instructions: CALL_ANALYSIS_INSTRUCTIONS,
        input: buildAnalysisInput(recording),
        text: { format: { type: 'json_schema', name: 'call_analysis', strict: true, schema: CALL_ANALYSIS_SCHEMA } }
    });
    const analysis = normalizeAnalysis(JSON.parse(response.output_text || '{}'));
    await setRecording(recordingId, agencyId, {
        status: 'analyzed',
        analysis: JSON.stringify(analysis),
        analyzed_at: new Date().toISOString(),
        error: null
    });
    return { status: 'analyzed', cached: false };
}

/** Step 3: write the analysis into the sales call (never over a manual edit). */
export async function applyRecordingAnalysis({ recordingId, agencyId }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const recording = await loadRecording(recordingId, agencyId, client);
        if (recording.status === 'applied') {
            await client.query('COMMIT');
            return { status: 'applied', changed: recording.applied_fields || [] };
        }
        if (!recording.analysis) throw new Error('Recording is not analysed');

        if (!recording.sales_call_id) {
            if (recording.match_reason !== 'positive_reply') throw new Error('Recording is not matched');
            if (!recording.analysis.is_sales_conversation) {
                await markUnmatched(recordingId, agencyId, 'positive_reply_not_sales', client);
                await client.query('COMMIT');
                return { status: 'unmatched', changed: [] };
            }
            const lead = await findPositiveReplyLead(agencyId, recording.external_emails || [], client);
            if (!lead) throw new Error('Positive-reply lead no longer found');
            const { rows: [created] } = await client.query(
                `INSERT INTO sales_calls (
                     agency_id, client_id, contact_id, company, contact_name, contact_email,
                     booked_at, call_at, call_status, ai_filled_fields
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'held', ARRAY['call_status', 'call_at']::text[])
                 RETURNING id`,
                [agencyId, lead.client_id, lead.contact_id, lead.domain_normalized, lead.full_name, lead.lead_email, recording.recorded_at]
            );
            await setRecording(recordingId, agencyId, { sales_call_id: created.id, client_id: lead.client_id }, client);
            recording.sales_call_id = created.id;
        }

        const { rows: [call] } = await client.query(
            `SELECT ${SALES_CALL_SELECT} FROM sales_calls WHERE id = $1 AND agency_id = $2 FOR UPDATE`,
            [recording.sales_call_id, agencyId]
        );
        if (!call) throw notFound(`sales call ${recording.sales_call_id} not found`);

        const { changes, filledFields } = planSalesCallUpdate(call, recording.analysis, recording);
        const recordedAt = recording.recorded_at ? new Date(recording.recorded_at) : null;
        const newest = !call.ai_source_recorded_at || (recordedAt && recordedAt >= new Date(call.ai_source_recorded_at));
        const meta = {
            ai_filled_fields: [...new Set([...(call.ai_filled_fields || []), ...filledFields])],
            ai_updated_at: new Date().toISOString(),
            ...(newest ? {
                ai_summary: recording.analysis.summary || call.ai_summary,
                recording_url: recording.share_url || recording.url || call.recording_url,
                ai_source_recorded_at: recordedAt ? recordedAt.toISOString() : call.ai_source_recorded_at
            } : {})
        };
        const fields = { ...changes, ...meta };
        const keys = Object.keys(fields);
        await client.query(
            `UPDATE sales_calls
             SET ${keys.map((key, i) => `${key} = $${i + 3}`).join(', ')}, updated_at = NOW()
             WHERE id = $1 AND agency_id = $2`,
            [call.id, agencyId, ...keys.map((key) => fields[key])]
        );
        await setRecording(recordingId, agencyId, { status: 'applied', applied_fields: Object.keys(changes) }, client);
        await client.query('COMMIT');
        return { status: 'applied', changed: Object.keys(changes) };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

export async function markRecordingFailed({ recordingId, agencyId, message }) {
    await setRecording(recordingId, agencyId, { status: 'failed', error: String(message || 'unknown error').slice(0, 2000) });
}

export async function attachCallAnalysisRunId({ recordingId, agencyId, workflowRunId }) {
    await setRecording(recordingId, agencyId, { workflow_run_id: workflowRunId });
}

/** match → analyze → apply in-process (local dev, or when workflows are off). */
export async function runCallAnalysisInline({ recordingId, agencyId }) {
    try {
        const match = await matchRecording({ recordingId, agencyId });
        if (match.status !== 'matched') return match;
        await analyzeRecording({ recordingId, agencyId });
        return await applyRecordingAnalysis({ recordingId, agencyId });
    } catch (error) {
        await markRecordingFailed({ recordingId, agencyId, message: error?.message || error });
        throw error;
    }
}

function isCallAnalysisWorkflowConfigured() {
    if (String(process.env.CALL_ANALYSIS_WORKFLOW_DISABLED || '').toLowerCase() === 'true') return false;
    return Boolean(String(process.env.WORKFLOW_TRIGGER_SECRET || '').trim());
}

/** Starts the Vercel workflow for one recording, or runs it inline. */
export async function triggerCallAnalysis({ recordingId, agencyId }) {
    if (!isCallAnalysisWorkflowConfigured()) {
        return runCallAnalysisInline({ recordingId, agencyId });
    }
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.WORKFLOW_TRIGGER_SECRET}`
    };
    if (process.env.VERCEL_PROTECTION_BYPASS) headers['x-vercel-protection-bypass'] = process.env.VERCEL_PROTECTION_BYPASS;
    const res = await fetch(`${resolveWorkflowStartBaseUrl()}/internal/call-analysis/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ recordingId, agencyId })
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Call-analysis workflow trigger failed (${res.status}): ${text || res.statusText}`);
    }
    return res.json();
}

/** Ingests recent Fathom recordings and analyses the new ones. */
export async function backfillFathomRecordings({ agencyId, days = 90, logger = console.info }) {
    const settings = await getAgencySettings(agencyId);
    const apiKey = String(settings?.fathom_key || '').trim();
    if (!apiKey) throw new Error('No Fathom API key saved for this agency.');
    const createdAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const meetings = await listFathomMeetings({ apiKey, createdAfter });
    const summary = { meetings: meetings.length, triggered: 0, skipped: 0, failed: 0 };
    for (const meeting of meetings) {
        try {
            const { recordingId, needsAnalysis } = await ingestFathomMeeting(agencyId, meeting);
            if (!needsAnalysis) {
                summary.skipped += 1;
                continue;
            }
            await triggerCallAnalysis({ recordingId, agencyId });
            summary.triggered += 1;
        } catch (error) {
            summary.failed += 1;
            logger(`[call-analysis] backfill failed for recording ${meeting?.recording_id}: ${error?.message || error}`);
        }
    }
    logger(`[call-analysis] backfill agency=${agencyId}: ${JSON.stringify(summary)}`);
    return summary;
}

/**
 * Registers (or re-registers) the agency's Fathom webhook after the key is
 * saved. Never points the webhook at a non-public URL, because local dev
 * shares the production database.
 */
export async function connectFathom({ agencyId, webhookBaseUrl }) {
    const settings = await getAgencySettings(agencyId);
    const apiKey = String(settings?.fathom_key || '').trim();
    if (!apiKey) return { connected: false, reason: 'no_key' };
    const base = String(process.env.FATHOM_WEBHOOK_BASE_URL || webhookBaseUrl || '').replace(/\/$/, '');
    if (!/^https:\/\//.test(base) || /localhost|127\.0\.0\.1/.test(base)) {
        return { connected: false, reason: 'no_public_url' };
    }
    if (settings.fathom_webhook_id) {
        await deleteFathomWebhook({ apiKey, webhookId: settings.fathom_webhook_id }).catch(() => {});
    }
    const webhook = await createFathomWebhook({ apiKey, destinationUrl: `${base}/webhooks/fathom/${encodeURIComponent(agencyId)}` });
    await pool.query(
        `UPDATE agency_settings SET fathom_webhook_id = $2, fathom_webhook_secret = $3, updated_at = NOW()
         WHERE agency_id = $1`,
        [agencyId, webhook.id, webhook.secret]
    );
    return { connected: true, webhookId: webhook.id };
}

function badRequest(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LINK_SEARCH_DAYS = 180;

/**
 * Finds a Fathom meeting by its call or share link. A recording we already
 * stored narrows the search to a few days around it; otherwise the last
 * LINK_SEARCH_DAYS are scanned without content, then the match is fetched
 * again with its transcript and summary.
 */
async function findFathomMeetingByUrl({ apiKey, url, known }) {
    const matches = (meeting) => normalizeFathomUrl(meeting?.url) === url
        || normalizeFathomUrl(meeting?.share_url) === url
        || (known && String(meeting?.recording_id) === String(known.external_id));
    const around = (iso) => ({
        createdAfter: new Date(new Date(iso).getTime() - 3 * DAY_MS).toISOString(),
        createdBefore: new Date(new Date(iso).getTime() + 3 * DAY_MS).toISOString()
    });

    if (known?.recorded_at) {
        const meetings = await listFathomMeetings({ apiKey, ...around(known.recorded_at), stopWhen: matches });
        const found = meetings.find(matches);
        if (found) return found;
    }
    const scan = await listFathomMeetings({
        apiKey,
        createdAfter: new Date(Date.now() - LINK_SEARCH_DAYS * DAY_MS).toISOString(),
        withContent: false,
        maxPages: 60,
        stopWhen: matches
    });
    const hit = scan.find(matches);
    if (!hit) return null;
    const full = await listFathomMeetings({ apiKey, ...around(hit.created_at || hit.recording_start_time), stopWhen: matches });
    return full.find((meeting) => String(meeting.recording_id) === String(hit.recording_id)) || null;
}

/**
 * The sales call to attach to: one chosen by hand; else the lead whose email
 * was given; else a match by outside attendee email; else a new entry.
 */
async function resolveSalesCallForLink({ agencyId, clientRow, recording, salesCallId, leadEmail = null }) {
    if (salesCallId) {
        const { rows: [call] } = await pool.query(
            'SELECT id FROM sales_calls WHERE id = $1 AND agency_id = $2 AND client_id = $3',
            [salesCallId, agencyId, clientRow.id]
        );
        if (!call) throw notFound('That sales log entry was not found for this client.');
        return { salesCallId: Number(call.id), created: false };
    }

    const invitees = Array.isArray(recording.invitees) ? recording.invitees : [];
    let emails;
    if (leadEmail) {
        emails = [leadEmail];
    } else {
        const ownDomains = await loadOwnDomains(agencyId);
        emails = (recording.external_emails || []).filter((email) => !ownDomains.has(email.split('@')[1]));
        if (!emails.length) {
            throw badRequest('This call has no outside attendee to match. Enter the lead’s email, or open the person in the sales log and link the call from there.');
        }
    }

    const { rows: [existing] } = await pool.query(
        `SELECT s.id
         FROM sales_calls s
         LEFT JOIN contacts c ON c.id = s.contact_id
         WHERE s.agency_id = $1 AND s.client_id = $2
           AND (LOWER(s.contact_email) = ANY($3::text[]) OR LOWER(c.email) = ANY($3::text[]))
         ORDER BY (s.call_status = 'canceled'), ABS(EXTRACT(EPOCH FROM (COALESCE(s.call_at, s.booked_at, s.created_at) - $4::timestamptz)))
         LIMIT 1`,
        [agencyId, clientRow.id, emails, recording.recorded_at || new Date().toISOString()]
    );
    if (existing) return { salesCallId: Number(existing.id), created: false };

    const email = emails[0];
    const invitee = invitees.find((i) => String(i?.email || '').toLowerCase() === email) || {};
    const { rows: [contact] } = await pool.query(
        `SELECT c.id, c.full_name, co.domain_normalized
         FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
         WHERE c.client_id = $1 AND LOWER(c.email) = $2 LIMIT 1`,
        [clientRow.id, email]
    );
    if (leadEmail && !contact) {
        throw badRequest(`No lead with the email ${leadEmail} in this client. Check the address, or leave it empty to match the call's attendees.`, 404);
    }
    const { rows: [created] } = await pool.query(
        `INSERT INTO sales_calls (
             agency_id, client_id, contact_id, company, contact_name, contact_email,
             booked_at, call_at, call_status, ai_filled_fields
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'held', ARRAY['call_status', 'call_at']::text[])
         RETURNING id`,
        [
            agencyId,
            clientRow.id,
            contact?.id || null,
            contact?.domain_normalized || businessDomains([email])[0] || null,
            contact?.full_name || invitee.name || null,
            email,
            recording.recorded_at || new Date().toISOString()
        ]
    );
    return { salesCallId: Number(created.id), created: true };
}

/**
 * Adds a Fathom call by its link and runs the AI analysis on it. It's attached
 * to the sales log entry picked by hand (salesCallId), else to whoever in this
 * client's sales log the outside attendee is, else to a new entry. A call that
 * was skipped before (its transcript discarded) is fetched again from Fathom.
 */
export async function linkFathomCall({ agencyId, clientRow, url: rawUrl, salesCallId = null, leadEmail: rawLeadEmail = null }) {
    const url = normalizeFathomUrl(rawUrl);
    if (!url) throw badRequest('Paste a Fathom call link, like https://fathom.video/calls/123… or https://fathom.video/share/….');
    const leadEmail = String(rawLeadEmail || '').trim().toLowerCase() || null;
    if (leadEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(leadEmail)) throw badRequest('That lead email doesn’t look right.');
    const settings = await getAgencySettings(agencyId);
    const apiKey = String(settings?.fathom_key || '').trim();
    if (!apiKey) throw badRequest('Connect Fathom first: save the Fathom API key in the API vault.');

    const { rows: [known] } = await pool.query(
        `SELECT external_id, recorded_at FROM call_recordings
         WHERE agency_id = $1 AND provider = 'fathom'
           AND (RTRIM(SPLIT_PART(url, '?', 1), '/') = $2 OR RTRIM(SPLIT_PART(share_url, '?', 1), '/') = $2)
         LIMIT 1`,
        [agencyId, url]
    );
    const meeting = await findFathomMeetingByUrl({ apiKey, url, known });
    if (!meeting) {
        throw badRequest('Fathom didn’t return that call. The saved Fathom key only sees calls recorded by, or shared with, its owner in the last six months.', 404);
    }
    if (!Array.isArray(meeting.transcript) || !meeting.transcript.length) {
        throw badRequest('Fathom hasn’t finished the transcript for this call yet. Try again in a few minutes.', 409);
    }

    // Start the recording over, so a previously skipped call keeps its
    // transcript and gets analysed again.
    await pool.query(
        `UPDATE call_recordings
         SET status = 'received', match_reason = NULL, analysis = NULL, applied_fields = '{}', error = NULL, updated_at = NOW()
         WHERE agency_id = $1 AND provider = 'fathom' AND external_id = $2`,
        [agencyId, String(meeting.recording_id)]
    );
    const { recordingId } = await ingestFathomMeeting(agencyId, meeting);
    const recording = await loadRecording(recordingId, agencyId);
    const target = await resolveSalesCallForLink({ agencyId, clientRow, recording, salesCallId, leadEmail: salesCallId ? null : leadEmail });

    await setRecording(recordingId, agencyId, {
        status: 'matched',
        match_reason: salesCallId ? 'manual' : (leadEmail ? 'manual_lead_email' : (target.created ? 'manual_new' : 'manual_email')),
        sales_call_id: target.salesCallId,
        client_id: clientRow.id
    });
    await triggerCallAnalysis({ recordingId, agencyId });
    return {
        recordingId,
        salesCallId: target.salesCallId,
        createdSalesCall: target.created,
        title: recording.title || null
    };
}

/** Progress of one linked call, for the sales log to poll. */
export async function getCallRecordingStatus({ agencyId, clientId, recordingId }) {
    const { rows: [row] } = await pool.query(
        `SELECT id, status, error, sales_call_id, applied_fields, title
         FROM call_recordings WHERE id = $1 AND agency_id = $2 AND client_id = $3`,
        [recordingId, agencyId, clientId]
    );
    return row || null;
}
