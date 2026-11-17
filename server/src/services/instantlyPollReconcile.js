/**
 * Webhook stand-in for an Instantly workspace that cannot register a webhook.
 *
 * Every 10 minutes (production API server), for clients with the poll turned
 * on and no webhook id:
 *   1. The first pass records currently interested leads and does not draft.
 *   2. Later passes draft when interest flips to interested, after saving the
 *      Unibox thread (reply id + sending account) so the draft is sendable.
 *   3. New received mail on someone already interested follows the normal
 *      post-autoresponder path.
 * ntfy is sent by the draft path, on the client's existing topic.
 */

import { pool } from '../config/db.js';
import {
    createInterestedAutoResponderDraftFromEvent,
    maybeCreatePostAutoresponderFollowUpDraft
} from './interestedAutoResponder.js';
import {
    ensureInstantlyContact,
    fetchInstantlyCampaigns,
    instantlyRequest,
    upsertCampaign
} from './instantlyState.js';

const POLL_SOURCE = 'poll_reconcile';
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const EMAIL_GAP_MS = 3200;
const CURSOR_OVERLAP_MS = 2 * 60 * 1000;
const INTEREST_SKEW_MS = 60 * 1000;
const LEAD_PAGE_LIMIT = 100;
const MAX_LEAD_PAGES = 50;
const EMAIL_PAGE_LIMIT = 100;
const MAX_EMAIL_PAGES = 4;
const MAX_TARGETED_THREAD_FETCHES = 20;
const MAX_BODY_HYDRATES = 8;

let lastEmailRequestAt = 0;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function asText(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

function asIso(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function extractItems(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.leads)) return payload.leads;
    if (Array.isArray(payload.emails)) return payload.emails;
    return [];
}

function nextStartingAfter(payload) {
    return payload?.next_starting_after || payload?.pagination?.next_starting_after || null;
}

export function isInstantlyPollReconcileEnabled(env = process.env) {
    const raw = String(env.INSTANTLY_POLL_RECONCILE_ENABLED ?? '').trim().toLowerCase();
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return env.NODE_ENV === 'production';
}

export function pollReconcileIntervalMs(env = process.env) {
    const parsed = Number.parseInt(env.INSTANTLY_POLL_RECONCILE_INTERVAL_MS || '', 10);
    const value = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
    return Math.max(value, MIN_INTERVAL_MS);
}

export function interestedLeadIdentity(lead) {
    const email = asText(lead?.email).toLowerCase();
    const campaignId = asText(lead?.campaign || lead?.campaign_id);
    const instantlyLeadId = asText(lead?.id) || null;
    const interestChangedAt = lead?.timestamp_last_interest_change || null;
    if (!email || !campaignId) return null;
    return { email, campaignId, instantlyLeadId, interestChangedAt };
}

export function dedupeInterestedLeads(leads) {
    const byKey = new Map();
    for (const lead of leads || []) {
        const identity = interestedLeadIdentity(lead);
        if (!identity) continue;
        const key = `${identity.campaignId}::${identity.email}`;
        const existing = byKey.get(key);
        const nextMs = Date.parse(identity.interestChangedAt || '') || 0;
        const prevMs = existing ? (Date.parse(existing.interestChangedAt || '') || 0) : -1;
        if (!existing || nextMs >= prevMs) byKey.set(key, { ...identity, lead });
    }
    return [...byKey.values()];
}

/** First pass records the baseline. Later passes draft only a new flip to interested. */
export function shouldDraftNewInterest({ previousInterestStatus, interestChangedAt, seededAt, seeding }) {
    if (seeding) return false;
    if (Number(previousInterestStatus) === 1) return false;
    if (!seededAt) return false;
    const seededMs = Date.parse(seededAt);
    if (!Number.isFinite(seededMs)) return false;
    const changedMs = Date.parse(interestChangedAt || '');
    if (!Number.isFinite(changedMs)) return true;
    return changedMs >= seededMs - INTEREST_SKEW_MS;
}

export function isInboundReply(email) {
    if (!email || !(email.id || email.uuid)) return false;
    if (Number(email.is_auto_reply) === 1) return false;
    if (email.ue_type === undefined || email.ue_type === null || email.ue_type === '') return true;
    return Number(email.ue_type) === 2;
}

export function emailBodyText(email) {
    const body = email?.body;
    if (typeof body === 'string') return body.trim();
    if (body && typeof body === 'object') {
        const text = asText(body.text);
        if (text) return text;
    }
    return asText(email?.content_preview);
}

export function emailPlainText(email) {
    const text = emailBodyText(email);
    if (text) return text;
    const html = email?.body && typeof email.body === 'object' ? email.body.html : '';
    if (typeof html !== 'string' || !html.trim()) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/\s+\n/g, '\n')
        .trim();
}

function emailTime(email) {
    const ms = Date.parse(email?.timestamp_email || email?.timestamp_created || '');
    return Number.isFinite(ms) ? ms : 0;
}

export function pickLatestInbound(emails) {
    const usable = (emails || []).filter((email) => isInboundReply(email) && asText(email.eaccount));
    usable.sort((a, b) => emailTime(b) - emailTime(a));
    return usable[0] || null;
}

export function groupInboundByLead(emails) {
    const grouped = new Map();
    for (const email of emails || []) {
        if (!isInboundReply(email)) continue;
        const lead = asText(email.lead).toLowerCase();
        const campaignId = asText(email.campaign_id);
        if (!lead || !campaignId) continue;
        const key = `${campaignId}::${lead}`;
        const list = grouped.get(key);
        if (list) list.push(email);
        else grouped.set(key, [email]);
    }
    return grouped;
}

function newestEmailMs(emails) {
    let newest = 0;
    for (const email of emails || []) {
        const ms = emailTime(email);
        if (ms > newest) newest = ms;
    }
    return newest || null;
}

export function nextEmailCursor({ previousCursor, emails, hitPageCap, now, overlapMs = CURSOR_OVERLAP_MS }) {
    if (hitPageCap) {
        const newest = newestEmailMs(emails);
        if (newest) return new Date(newest - 1000).toISOString();
    }
    const caughtUp = now - overlapMs;
    const previous = Date.parse(previousCursor || '');
    if (Number.isFinite(previous) && previous > caughtUp) return new Date(previous).toISOString();
    return new Date(caughtUp).toISOString();
}

export function pollReplyFingerprint(emailId) {
    return `poll-reply:${emailId}`;
}

export function pollInterestFingerprint({ contactId, campaignId, previousInterestStatus, eventTimestamp }) {
    return [
        'poll-interest',
        contactId,
        campaignId,
        previousInterestStatus ?? '',
        eventTimestamp || ''
    ].join(':');
}

async function emailGap() {
    const wait = EMAIL_GAP_MS - (Date.now() - lastEmailRequestAt);
    if (wait > 0) await sleep(wait);
    lastEmailRequestAt = Date.now();
}

async function listPages(apiKey, { path, method, bodyForPage, maxPages }) {
    const rows = [];
    let startingAfter = null;
    let hitPageCap = false;
    for (let page = 0; page < maxPages; page += 1) {
        const body = bodyForPage ? bodyForPage(startingAfter) : null;
        const payload = await instantlyRequest({
            apiKey,
            path: body ? path : `${path}${startingAfter ? `&starting_after=${encodeURIComponent(startingAfter)}` : ''}`,
            method,
            body: body || undefined
        });
        const items = extractItems(payload);
        rows.push(...items);
        const next = nextStartingAfter(payload);
        if (!next || next === startingAfter || items.length === 0) {
            hitPageCap = false;
            break;
        }
        startingAfter = next;
        hitPageCap = page === maxPages - 1;
    }
    return { rows, hitPageCap };
}

async function listInterestedInCampaign(apiKey, campaignId) {
    const { rows } = await listPages(apiKey, {
        path: '/api/v2/leads/list',
        method: 'POST',
        maxPages: MAX_LEAD_PAGES,
        bodyForPage: (startingAfter) => ({
            filter: 'FILTER_LEAD_INTERESTED',
            limit: LEAD_PAGE_LIMIT,
            ...(campaignId ? { campaign: campaignId } : {}),
            ...(startingAfter ? { starting_after: startingAfter } : {})
        })
    });
    if (!campaignId) return rows;
    return rows.map((lead) => (lead?.campaign || lead?.campaign_id ? lead : { ...lead, campaign: campaignId }));
}

async function listInterestedLeads(apiKey, logger) {
    try {
        return await listInterestedInCampaign(apiKey, null);
    } catch (error) {
        const status = Number(error?.statusCode);
        if (status !== 400 && status !== 422) throw error;
        logger(`workspace interested list rejected (${error.message}); listing each campaign`);
        const campaigns = await fetchInstantlyCampaigns(apiKey);
        const rows = [];
        for (const campaign of campaigns) {
            const id = asText(campaign?.id || campaign?.campaignId || campaign?.uuid || campaign?._id);
            if (!id) continue;
            rows.push(...await listInterestedInCampaign(apiKey, id));
        }
        return rows;
    }
}

async function listReceivedEmails(apiKey, minTimestamp) {
    const params = new URLSearchParams({
        email_type: 'received',
        limit: String(EMAIL_PAGE_LIMIT),
        sort_order: 'asc',
        preview_only: 'false'
    });
    if (minTimestamp) params.set('min_timestamp_created', new Date(minTimestamp).toISOString());
    await emailGap();
    const rows = [];
    let startingAfter = null;
    let hitPageCap = false;
    for (let page = 0; page < MAX_EMAIL_PAGES; page += 1) {
        if (page > 0) await emailGap();
        const pageParams = new URLSearchParams(params);
        if (startingAfter) pageParams.set('starting_after', startingAfter);
        const payload = await instantlyRequest({
            apiKey,
            path: `/api/v2/emails?${pageParams.toString()}`,
            method: 'GET'
        });
        const items = extractItems(payload);
        rows.push(...items);
        const next = nextStartingAfter(payload);
        if (!next || next === startingAfter || items.length < EMAIL_PAGE_LIMIT) {
            hitPageCap = false;
            break;
        }
        startingAfter = next;
        hitPageCap = page === MAX_EMAIL_PAGES - 1;
    }
    return { emails: rows, hitPageCap };
}

async function hydrateEmail(apiKey, email) {
    if (!email?.id || (emailPlainText(email) && !email.body_fallback_reason)) return email;
    try {
        await emailGap();
        const full = await instantlyRequest({
            apiKey,
            path: `/api/v2/emails/${encodeURIComponent(email.id)}`,
            method: 'GET'
        });
        return full && typeof full === 'object' ? { ...email, ...full } : email;
    } catch {
        return email;
    }
}

async function fetchLatestInbound(apiKey, { leadEmail, campaignId }) {
    await emailGap();
    const params = new URLSearchParams({
        lead: leadEmail,
        limit: '20',
        sort_order: 'desc',
        preview_only: 'false'
    });
    if (campaignId) params.set('campaign_id', campaignId);
    const payload = await instantlyRequest({
        apiKey,
        path: `/api/v2/emails?${params.toString()}`,
        method: 'GET'
    });
    const picked = pickLatestInbound(extractItems(payload));
    if (!picked) return null;
    return hydrateEmail(apiKey, picked);
}

async function loadCampaignNames(apiKey, logger) {
    const names = new Map();
    try {
        const campaigns = await fetchInstantlyCampaigns(apiKey);
        for (const campaign of campaigns) {
            const id = asText(campaign?.id || campaign?.campaignId || campaign?.uuid || campaign?._id);
            if (!id) continue;
            names.set(id, asText(campaign?.name) || id);
        }
    } catch (error) {
        logger(`campaign names unavailable: ${error.message}`);
    }
    return names;
}

async function loadPriorInterest(clientId, emails) {
    const map = new Map();
    if (!emails.length) return map;
    const { rows } = await pool.query(
        `SELECT LOWER(c.email) AS email, ic.instantly_campaign_id, cic.interest_status
         FROM contact_instantly_campaigns cic
         JOIN contacts c ON c.id = cic.contact_id
         JOIN instantly_campaigns ic ON ic.id = cic.campaign_id
         WHERE c.client_id = $1
           AND LOWER(c.email) = ANY($2::text[])`,
        [clientId, emails]
    );
    for (const row of rows) {
        map.set(`${row.instantly_campaign_id}::${row.email}`, row.interest_status);
    }
    return map;
}

async function loadPendingPollDrafts(clientId) {
    const { rows } = await pool.query(
        `SELECT DISTINCT ON (e.contact_id, e.campaign_id)
                e.id AS source_event_id,
                LOWER(c.email) AS email,
                ic.instantly_campaign_id
         FROM contact_instantly_events e
         JOIN contacts c ON c.id = e.contact_id
         JOIN instantly_campaigns ic ON ic.id = e.campaign_id
         WHERE e.client_id = $1
           AND e.source = $2
           AND e.event_type = 'lead_interested'
           AND NOT EXISTS (
               SELECT 1
               FROM interested_autoresponder_drafts d
               WHERE d.source_event_id = e.id
                 AND d.status NOT IN ('blocked_missing_thread', 'cancelled')
           )
         ORDER BY e.contact_id, e.campaign_id, e.event_timestamp DESC`,
        [clientId, POLL_SOURCE]
    );
    const map = new Map();
    for (const row of rows) {
        map.set(`${row.instantly_campaign_id}::${row.email}`, Number(row.source_event_id));
    }
    return map;
}

async function upsertInterestedMembership(db, { contactId, campaignId, instantlyLeadId, interestChangedAt, timestampLastReply, lead }) {
    if (instantlyLeadId) {
        await db.query(
            `DELETE FROM contact_instantly_campaigns
             WHERE campaign_id = $1 AND instantly_lead_id = $2 AND contact_id <> $3`,
            [campaignId, instantlyLeadId, contactId]
        );
    }
    const prior = await db.query(
        `SELECT interest_status
         FROM contact_instantly_campaigns
         WHERE contact_id = $1 AND campaign_id = $2`,
        [contactId, campaignId]
    );
    const previous = prior.rowCount ? prior.rows[0].interest_status : null;
    await db.query(
        `INSERT INTO contact_instantly_campaigns (
            contact_id, campaign_id, upload_source, instantly_lead_id, active, last_seen_at, removed_at,
            interest_status, interest_status_label, timestamp_last_interest_change,
            timestamp_last_reply, last_synced_at, raw_lead_payload
         ) VALUES (
            $1, $2, 'instantly_sync', $3, TRUE, NOW(), NULL,
            1, 'Interested', $4,
            $5, NOW(), $6::jsonb
         )
         ON CONFLICT (contact_id, campaign_id) DO UPDATE SET
            instantly_lead_id = COALESCE(EXCLUDED.instantly_lead_id, contact_instantly_campaigns.instantly_lead_id),
            active = TRUE,
            last_seen_at = NOW(),
            removed_at = NULL,
            interest_status = 1,
            interest_status_label = 'Interested',
            timestamp_last_interest_change = COALESCE(EXCLUDED.timestamp_last_interest_change, contact_instantly_campaigns.timestamp_last_interest_change),
            timestamp_last_reply = COALESCE(EXCLUDED.timestamp_last_reply, contact_instantly_campaigns.timestamp_last_reply),
            last_synced_at = NOW(),
            raw_lead_payload = EXCLUDED.raw_lead_payload`,
        [
            contactId,
            campaignId,
            instantlyLeadId,
            interestChangedAt || null,
            timestampLastReply || null,
            JSON.stringify(lead || {})
        ]
    );
    return previous;
}

function replySnippet(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    return clean.length > 280 ? `${clean.slice(0, 277)}...` : clean;
}

async function insertPollReply(db, {
    agencyId, clientId, contactId, campaignId, instantlyCampaignId, instantlyLeadId, leadEmail, email
}) {
    const emailId = asText(email.id || email.uuid);
    if (!emailId) return null;
    const text = emailPlainText(email);
    const subject = asText(email.subject) || null;
    const eventTimestamp = email.timestamp_email || email.timestamp_created || new Date().toISOString();
    const snippet = replySnippet(text);
    const payload = {
        event_type: 'reply_received',
        source: POLL_SOURCE,
        subject,
        email_subject: subject,
        email_text: text || null,
        reply_text: text || null,
        reply_text_snippet: snippet,
        email_id: emailId
    };
    const result = await db.query(
        `INSERT INTO contact_instantly_events (
            agency_id, client_id, contact_id, campaign_id, instantly_campaign_id, instantly_lead_id,
            event_type, reply_category, lead_email, email_account, message_text, reply_text_snippet,
            reply_to_uuid, event_timestamp, fingerprint, source, payload
         ) VALUES (
            $1, $2, $3, $4, $5, $6,
            'reply_received', 'positive', $7, $8, $9, $10,
            $11, $12, $13, $14, $15::jsonb
         )
         ON CONFLICT (source, fingerprint) DO NOTHING
         RETURNING id`,
        [
            agencyId,
            clientId,
            contactId,
            campaignId,
            instantlyCampaignId,
            instantlyLeadId,
            leadEmail,
            asText(email.eaccount) || null,
            text || null,
            snippet,
            emailId,
            eventTimestamp,
            pollReplyFingerprint(emailId),
            POLL_SOURCE,
            JSON.stringify(payload)
        ]
    );
    return result.rows[0]?.id || null;
}

async function insertPollInterest(db, {
    agencyId, clientId, contactId, campaignId, instantlyCampaignId, instantlyLeadId, leadEmail,
    previousInterestStatus, eventTimestamp
}) {
    const payload = {
        event_type: 'lead_interested',
        source: POLL_SOURCE,
        lead_email: leadEmail,
        previous_interest_status: previousInterestStatus,
        next_interest_status: 1
    };
    const result = await db.query(
        `INSERT INTO contact_instantly_events (
            agency_id, client_id, contact_id, campaign_id, instantly_campaign_id, instantly_lead_id,
            event_type, reply_category, lead_email, event_timestamp, fingerprint, source, payload
         ) VALUES (
            $1, $2, $3, $4, $5, $6,
            'lead_interested', 'positive', $7, $8, $9, $10, $11::jsonb
         )
         ON CONFLICT (source, fingerprint) DO NOTHING
         RETURNING id`,
        [
            agencyId,
            clientId,
            contactId,
            campaignId,
            instantlyCampaignId,
            instantlyLeadId,
            leadEmail,
            eventTimestamp,
            pollInterestFingerprint({
                contactId,
                campaignId,
                previousInterestStatus,
                eventTimestamp
            }),
            POLL_SOURCE,
            JSON.stringify(payload)
        ]
    );
    if (!result.rows[0]?.id) return null;
    await db.query(
        `UPDATE contact_instantly_campaigns
         SET last_event_type = 'lead_interested',
             last_reply_category = 'positive'
         WHERE contact_id = $1 AND campaign_id = $2`,
        [contactId, campaignId]
    );
    return result.rows[0].id;
}

async function loadPollState(clientId) {
    const { rows } = await pool.query(
        `SELECT id,
                instantly_poll_seeded_at AS seeded_at,
                instantly_poll_email_cursor AS email_cursor,
                instantly_webhook_id AS webhook_id
         FROM clients WHERE id = $1`,
        [clientId]
    );
    return rows[0] || null;
}

function settingsFromRow(row) {
    if (!row) return null;
    return {
        enabled: row.enabled === true,
        seeded_at: row.seeded_at,
        last_run_at: row.last_run_at,
        last_error: row.last_error,
        last_summary: row.last_summary && typeof row.last_summary === 'object' ? row.last_summary : {},
        webhook_linked: Boolean(row.webhook_id),
        has_api_key: Boolean(asText(row.instantly_key))
    };
}

const SETTINGS_SQL = `instantly_poll_reconcile AS enabled,
            instantly_poll_seeded_at AS seeded_at,
            instantly_poll_last_run_at AS last_run_at,
            instantly_poll_last_error AS last_error,
            instantly_poll_last_summary AS last_summary,
            instantly_webhook_id AS webhook_id,
            instantly_key`;

export async function getPollReconcileSettings(clientId) {
    const { rows } = await pool.query(`SELECT ${SETTINGS_SQL} FROM clients WHERE id = $1`, [clientId]);
    return settingsFromRow(rows[0]);
}

export async function updatePollReconcileSettings(clientId, { enabled }) {
    const { rows } = await pool.query(
        `UPDATE clients
         SET instantly_poll_reconcile = COALESCE($2, instantly_poll_reconcile)
         WHERE id = $1
         RETURNING ${SETTINGS_SQL}`,
        [clientId, typeof enabled === 'boolean' ? enabled : null]
    );
    return settingsFromRow(rows[0]);
}

async function listDuePollClients() {
    const { rows } = await pool.query(
        `SELECT id, agency_id, slug, instantly_key
         FROM clients
         WHERE instantly_poll_reconcile = TRUE
           AND instantly_webhook_id IS NULL
           AND instantly_key IS NOT NULL AND BTRIM(instantly_key) <> ''
           AND (instantly_poll_last_run_at IS NULL
                OR instantly_poll_last_run_at < NOW() - make_interval(secs => $1::float8))
         ORDER BY instantly_poll_last_run_at NULLS FIRST`,
        [pollReconcileIntervalMs() / 1000]
    );
    return rows;
}

async function reconcileOnce({ state, agencyId, clientId, clientSlug, instantlyKey, startedAt, logger }) {
    state = {
        ...state,
        seeded_at: asIso(state.seeded_at),
        email_cursor: asIso(state.email_cursor)
    };
    const seeding = !state.seeded_at;
    const names = await loadCampaignNames(instantlyKey, logger);
    const leads = dedupeInterestedLeads(await listInterestedLeads(instantlyKey, logger));
    const interestedKeys = new Set(leads.map((row) => `${row.campaignId}::${row.email}`));
    logger(`${seeding ? 'seeding' : 'checking'} ${leads.length} interested lead(s)`);

    let received = [];
    let hitPageCap = false;
    if (!seeding) {
        const listed = await listReceivedEmails(instantlyKey, state.email_cursor || state.seeded_at);
        received = listed.emails;
        hitPageCap = listed.hitPageCap;
        logger(`received ${received.length} email(s) since ${state.email_cursor || state.seeded_at}${hitPageCap ? ' (more remain)' : ''}`);
    }

    const prior = await loadPriorInterest(clientId, leads.map((row) => row.email));
    const pending = seeding ? new Map() : await loadPendingPollDrafts(clientId);
    const grouped = groupInboundByLead(received);

    let targeted = 0;
    const anchors = new Map();
    for (const row of leads) {
        const key = `${row.campaignId}::${row.email}`;
        const previous = prior.has(key) ? prior.get(key) : null;
        const draft = shouldDraftNewInterest({
            previousInterestStatus: previous,
            interestChangedAt: row.interestChangedAt,
            seededAt: state.seeded_at,
            seeding
        });
        const retry = !draft && pending.has(key);
        if (!draft && !retry) continue;
        let anchor = pickLatestInbound(grouped.get(key) || []);
        if (!anchor && targeted < MAX_TARGETED_THREAD_FETCHES) {
            targeted += 1;
            anchor = await fetchLatestInbound(instantlyKey, { leadEmail: row.email, campaignId: row.campaignId });
        } else if (anchor && !emailPlainText(anchor)) {
            anchor = await hydrateEmail(instantlyKey, anchor);
        }
        if (anchor) anchors.set(key, anchor);
    }

    const placed = new Map();
    const triggers = [];
    let repliesStored = 0;
    const db = await pool.connect();
    try {
        await db.query('BEGIN');
        for (const row of leads) {
            const key = `${row.campaignId}::${row.email}`;
            const sqlCampaignId = await upsertCampaign(db, {
                agencyId,
                clientId,
                instantlyCampaignId: row.campaignId,
                name: names.get(row.campaignId) || row.campaignId,
                rawCampaignPayload: { id: row.campaignId, name: names.get(row.campaignId) || null },
                lastSyncedAt: startedAt.toISOString()
            });
            const contactId = await ensureInstantlyContact(db, {
                agencyId,
                clientId,
                campaign: {
                    instantlyCampaignId: row.campaignId,
                    campaignName: names.get(row.campaignId) || row.campaignId
                },
                lead: row.lead,
                source: POLL_SOURCE
            });
            if (!contactId || !sqlCampaignId) continue;

            const previous = await upsertInterestedMembership(db, {
                contactId,
                campaignId: sqlCampaignId,
                instantlyLeadId: row.instantlyLeadId,
                interestChangedAt: row.interestChangedAt,
                timestampLastReply: row.lead?.timestamp_last_reply || null,
                lead: row.lead
            });
            placed.set(key, {
                contactId,
                sqlCampaignId,
                instantlyLeadId: row.instantlyLeadId,
                leadEmail: row.email
            });

            const draft = shouldDraftNewInterest({
                previousInterestStatus: previous,
                interestChangedAt: row.interestChangedAt,
                seededAt: state.seeded_at,
                seeding
            });
            const pendingEventId = pending.get(key) || null;
            const retry = !draft && Boolean(pendingEventId);
            if (!draft && !retry) continue;

            const anchor = anchors.get(key);
            if (anchor && asText(anchor.eaccount)) {
                const replyId = await insertPollReply(db, {
                    agencyId,
                    clientId,
                    contactId,
                    campaignId: sqlCampaignId,
                    instantlyCampaignId: row.campaignId,
                    instantlyLeadId: row.instantlyLeadId || asText(anchor.lead_id) || null,
                    leadEmail: row.email,
                    email: anchor
                });
                if (replyId) repliesStored += 1;
            }

            let sourceEventId = pendingEventId;
            if (draft) {
                const eventTimestamp = row.interestChangedAt || startedAt.toISOString();
                const insertedId = await insertPollInterest(db, {
                    agencyId,
                    clientId,
                    contactId,
                    campaignId: sqlCampaignId,
                    instantlyCampaignId: row.campaignId,
                    instantlyLeadId: row.instantlyLeadId,
                    leadEmail: row.email,
                    previousInterestStatus: previous,
                    eventTimestamp
                });
                if (insertedId) sourceEventId = insertedId;
            }
            // A new flip is drafted once, even if the thread is still missing (the
            // row lands blocked and the next pass retries). A retry only fires
            // once the thread is actually here, so we don't recreate that row
            // every 10 minutes.
            const readyToDraft = draft || (retry && anchor && asText(anchor.eaccount));
            if (sourceEventId && readyToDraft) {
                triggers.push({
                    campaignId: sqlCampaignId,
                    contactId,
                    instantlyLeadId: row.instantlyLeadId,
                    sourceEventId,
                    leadEmail: row.email
                });
            }
        }

        if (seeding) {
            await db.query(
                `UPDATE clients
                 SET instantly_poll_seeded_at = COALESCE(instantly_poll_seeded_at, $2),
                     instantly_poll_email_cursor = COALESCE(instantly_poll_email_cursor, $2)
                 WHERE id = $1`,
                [clientId, startedAt.toISOString()]
            );
        }
        await db.query('COMMIT');
    } catch (error) {
        await db.query('ROLLBACK');
        throw error;
    } finally {
        db.release();
    }

    let drafted = 0;
    let draftErrors = 0;
    for (const trigger of triggers) {
        try {
            const result = await createInterestedAutoResponderDraftFromEvent({
                agencyId,
                clientSlug,
                clientId,
                campaignId: trigger.campaignId,
                contactId: trigger.contactId,
                instantlyLeadId: trigger.instantlyLeadId,
                sourceEventId: trigger.sourceEventId,
                leadEmail: trigger.leadEmail,
                logger
            });
            if (result?.created || result?.researching) drafted += 1;
            else logger(`draft not created for ${trigger.leadEmail}: ${result?.reason || 'skipped'}`);
        } catch (error) {
            draftErrors += 1;
            logger(`draft failed for ${trigger.leadEmail}: ${error.message}`);
        }
    }

    const followTriggers = [];
    if (!seeding && received.length) {
        let hydrates = 0;
        for (let index = 0; index < received.length; index += 1) {
            const email = received[index];
            if (!isInboundReply(email) || emailPlainText(email) || hydrates >= MAX_BODY_HYDRATES) continue;
            const key = `${asText(email.campaign_id)}::${asText(email.lead).toLowerCase()}`;
            if (!interestedKeys.has(key) || !placed.has(key)) continue;
            hydrates += 1;
            received[index] = await hydrateEmail(instantlyKey, email);
        }

        const followDb = await pool.connect();
        try {
            await followDb.query('BEGIN');
            for (const email of received) {
                if (!isInboundReply(email) || !asText(email.eaccount)) continue;
                const key = `${asText(email.campaign_id)}::${asText(email.lead).toLowerCase()}`;
                const place = placed.get(key);
                if (!place) continue;
                const replyId = await insertPollReply(followDb, {
                    agencyId,
                    clientId,
                    contactId: place.contactId,
                    campaignId: place.sqlCampaignId,
                    instantlyCampaignId: asText(email.campaign_id),
                    instantlyLeadId: place.instantlyLeadId || asText(email.lead_id) || null,
                    leadEmail: place.leadEmail,
                    email
                });
                if (!replyId) continue;
                repliesStored += 1;
                followTriggers.push({
                    ...place,
                    replyId,
                    replyCategory: 'positive',
                    eventTimestamp: email.timestamp_email || email.timestamp_created || startedAt.toISOString(),
                    instantlyCampaignId: asText(email.campaign_id)
                });
            }
            await followDb.query('COMMIT');
        } catch (error) {
            await followDb.query('ROLLBACK');
            throw error;
        } finally {
            followDb.release();
        }
    }

    let followUps = 0;
    for (const trigger of followTriggers) {
        try {
            const result = await maybeCreatePostAutoresponderFollowUpDraft({
                agencyId,
                clientSlug,
                clientId,
                campaignId: trigger.sqlCampaignId,
                contactId: trigger.contactId,
                instantlyLeadId: trigger.instantlyLeadId,
                leadEmail: trigger.leadEmail,
                replyEventId: trigger.replyId,
                interestStatus: 1,
                replyCategory: trigger.replyCategory,
                logger
            });
            if (result?.created || result?.researching) {
                followUps += 1;
                continue;
            }
            // Already interested before this poll existed, and a new reply just arrived.
            // That reply is the first one we can act on, so draft it like a webhook.
            if (result?.reason !== 'no_prior_autoresponder') continue;
            const sourceEventId = await insertPollInterest(pool, {
                agencyId,
                clientId,
                contactId: trigger.contactId,
                campaignId: trigger.sqlCampaignId,
                instantlyCampaignId: trigger.instantlyCampaignId,
                instantlyLeadId: trigger.instantlyLeadId,
                leadEmail: trigger.leadEmail,
                previousInterestStatus: 1,
                eventTimestamp: trigger.eventTimestamp
            });
            if (!sourceEventId) continue;
            const first = await createInterestedAutoResponderDraftFromEvent({
                agencyId,
                clientSlug,
                clientId,
                campaignId: trigger.sqlCampaignId,
                contactId: trigger.contactId,
                instantlyLeadId: trigger.instantlyLeadId,
                sourceEventId,
                replySourceEventId: trigger.replyId,
                leadEmail: trigger.leadEmail,
                logger
            });
            if (first?.created || first?.researching) drafted += 1;
            else logger(`draft not created for ${trigger.leadEmail}: ${first?.reason || 'skipped'}`);
        } catch (error) {
            logger(`follow-up draft failed for ${trigger.leadEmail}: ${error.message}`);
        }
    }

    const emailCursor = seeding
        ? startedAt.toISOString()
        : nextEmailCursor({
            previousCursor: state.email_cursor || state.seeded_at,
            emails: received,
            hitPageCap,
            now: Date.now()
        });

    return {
        seeded: seeding,
        interested: leads.length,
        drafted,
        followUps,
        repliesStored,
        draftErrors,
        emailCursor,
        at: startedAt.toISOString()
    };
}

export async function runInstantlyPollReconcile({
    agencyId,
    clientId,
    clientSlug,
    instantlyKey,
    force = false,
    logger = () => {}
}) {
    const state = await loadPollState(clientId);
    if (!state) {
        const error = new Error('Client not found.');
        error.statusCode = 404;
        throw error;
    }
    if (!force && state.webhook_id) {
        logger('skipped: Instantly webhook is linked');
        return { skipped: 'webhook_linked' };
    }
    if (!asText(instantlyKey)) {
        const error = new Error('Client is missing an Instantly API key.');
        error.statusCode = 400;
        throw error;
    }

    await pool.query(
        `UPDATE clients
         SET instantly_poll_last_run_at = NOW(), instantly_poll_last_error = NULL
         WHERE id = $1`,
        [clientId]
    );

    const startedAt = new Date();
    try {
        const summary = await reconcileOnce({
            state,
            agencyId,
            clientId,
            clientSlug,
            instantlyKey,
            startedAt,
            logger
        });
        await pool.query(
            `UPDATE clients
             SET instantly_poll_email_cursor = $2,
                 instantly_poll_last_summary = $3::jsonb,
                 instantly_poll_last_error = NULL
             WHERE id = $1`,
            [clientId, summary.emailCursor, JSON.stringify(summary)]
        );
        logger(
            summary.seeded
                ? `seeded ${summary.interested} interested lead(s); no drafts`
                : `drafted ${summary.drafted}, follow-ups ${summary.followUps}, replies stored ${summary.repliesStored}`
        );
        return summary;
    } catch (error) {
        await pool.query(
            `UPDATE clients
             SET instantly_poll_last_error = $2
             WHERE id = $1`,
            [clientId, String(error?.message || error).slice(0, 2000)]
        );
        throw error;
    }
}

export async function runInstantlyPollReconcileSweep() {
    for (const client of await listDuePollClients()) {
        const label = `${client.agency_id}/${client.slug}`;
        try {
            await runInstantlyPollReconcile({
                agencyId: client.agency_id,
                clientId: client.id,
                clientSlug: client.slug,
                instantlyKey: client.instantly_key,
                logger: (message) => console.log(`[instantly-poll][${label}] ${message}`)
            });
        } catch (error) {
            console.error(`[instantly-poll][${label}] failed:`, error?.message || error);
        }
    }
}

export function startInstantlyPollReconcileSweep() {
    if (!isInstantlyPollReconcileEnabled()) {
        console.log('[instantly-poll] sweep disabled (INSTANTLY_POLL_RECONCILE_ENABLED / NODE_ENV)');
        return () => {};
    }
    const intervalMs = pollReconcileIntervalMs();
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            await runInstantlyPollReconcileSweep();
        } catch (error) {
            console.error('[instantly-poll] sweep failed:', error?.message || error);
        } finally {
            running = false;
        }
    };
    const initial = setTimeout(tick, 90_000);
    const interval = setInterval(tick, intervalMs);
    initial.unref?.();
    interval.unref?.();
    console.log(`[instantly-poll] sweep every ${Math.round(intervalMs / 60000)}m`);
    return () => {
        clearTimeout(initial);
        clearInterval(interval);
    };
}
