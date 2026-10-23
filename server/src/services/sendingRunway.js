/**
 * Sending runway for the Analytics tab: how many sending days until active
 * Instantly campaigns stop starting new prospects.
 *
 * New-lead capacity comes from Instantly's own settings, read live (the stored
 * instantly_campaigns.raw_campaign_payload is sometimes a stub):
 * - inboxes = the campaign's email_list plus every account carrying one of its
 *   email_tag_list tags; only active accounts (status 1) count. An inbox used by
 *   several active campaigns has its daily_limit split evenly between them,
 *   since Instantly shares one inbox's limit across campaigns.
 * - sends/day = min(Σ inbox daily_limit share, campaign daily_limit).
 * - new leads/day = sends/day ÷ sequence steps (each prospect gets one email per
 *   step, so with 3 steps a third of volume goes to new prospects), capped by
 *   the campaign's daily_max_leads.
 * Backlog = active campaign leads Shields has synced that were never contacted.
 *
 * Results are cached in memory per client (the API host is a single process);
 * a cold load costs one campaigns call plus a few paged account calls.
 */

import { fetchInstantlyAccounts, fetchInstantlyCampaigns, instantlyRequest } from './instantlyState.js';

const CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_STEPS = 3;
const DEFAULT_SCHEDULE_DAYS = [1, 2, 3, 4, 5];
const MAX_RUNWAY_WALK_DAYS = 3 * 365;

const cache = new Map();
const inFlight = new Map();

const CAMPAIGN_STATUS_LABELS = { 0: 'draft', 1: 'active', 2: 'paused', 3: 'completed', 4: 'running subsequences' };

function positiveNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

/** Weekdays (0 = Sunday) the campaign sends on, from its first schedule. */
export function campaignScheduleDays(campaign) {
    const days = campaign?.campaign_schedule?.schedules?.[0]?.days;
    if (!days || typeof days !== 'object') return DEFAULT_SCHEDULE_DAYS;
    const enabled = Object.entries(days)
        .filter(([, on]) => on === true)
        .map(([day]) => Number(day))
        .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
        .sort();
    return enabled.length ? enabled : DEFAULT_SCHEDULE_DAYS;
}

/**
 * The calendar date of the Nth sending day counting today (if it is one).
 * Returns YYYY-MM-DD (UTC calendar), or null when it is out of range.
 */
export function addSendingDays(fromDate, sendingDays, scheduleDays) {
    if (!Number.isFinite(sendingDays) || sendingDays < 0) return null;
    const allowed = new Set(scheduleDays.length ? scheduleDays : DEFAULT_SCHEDULE_DAYS);
    const date = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), fromDate.getUTCDate()));
    let remaining = Math.max(1, Math.ceil(sendingDays));
    for (let i = 0; i < MAX_RUNWAY_WALK_DAYS; i += 1) {
        if (allowed.has(date.getUTCDay())) {
            remaining -= 1;
            if (remaining === 0) return date.toISOString().slice(0, 10);
        }
        date.setUTCDate(date.getUTCDate() + 1);
    }
    return null;
}

function roundDays(value) {
    return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/**
 * Pure runway computation. Exported for tests.
 *
 * @param {{
 *   campaigns: object[],                       Instantly campaign objects
 *   accounts: object[],                        Instantly account objects (all)
 *   taggedEmails: Map<string, string[]>,       tag id → account emails
 *   backlog: Map<string, { notContacted: number, inSequence: number }>, by Instantly campaign id
 *   reserve: { verified: number, withFirstLine: number },
 *   now?: Date
 * }} input
 */
export function computeSendingRunway({ campaigns, accounts, taggedEmails, backlog, reserve, now = new Date() }) {
    const accountByEmail = new Map();
    for (const account of accounts) {
        const email = normalizeEmail(account?.email);
        if (email) accountByEmail.set(email, account);
    }
    const isActiveAccount = (account) => Number(account?.status) === 1;

    const campaignInboxes = new Map();
    for (const campaign of campaigns) {
        const emails = new Set((Array.isArray(campaign?.email_list) ? campaign.email_list : []).map(normalizeEmail).filter(Boolean));
        for (const tagId of Array.isArray(campaign?.email_tag_list) ? campaign.email_tag_list : []) {
            for (const email of taggedEmails.get(String(tagId)) || []) emails.add(normalizeEmail(email));
        }
        campaignInboxes.set(String(campaign.id), emails);
    }

    const activeCampaigns = campaigns.filter((campaign) => Number(campaign?.status) === 1);
    const campaignsPerInbox = new Map();
    for (const campaign of activeCampaigns) {
        for (const email of campaignInboxes.get(String(campaign.id))) {
            campaignsPerInbox.set(email, (campaignsPerInbox.get(email) || 0) + 1);
        }
    }

    const warnings = [];
    const rows = [];
    for (const campaign of campaigns) {
        const id = String(campaign.id);
        const status = Number(campaign?.status);
        const active = status === 1;
        const counts = backlog.get(id) || { notContacted: 0, inSequence: 0 };
        // Only campaigns that are running or still hold leads are worth showing.
        if (!active && !counts.notContacted && !counts.inSequence) continue;

        const inboxEmails = [...campaignInboxes.get(id)];
        const activeInboxes = inboxEmails.map((email) => accountByEmail.get(email)).filter(isActiveAccount);
        const sharedInboxes = active
            ? activeInboxes.filter((account) => (campaignsPerInbox.get(normalizeEmail(account.email)) || 0) > 1).length
            : 0;
        const inboxCapacity = activeInboxes.reduce((sum, account) => {
            const limit = positiveNumber(account?.daily_limit) || 0;
            const share = active ? (campaignsPerInbox.get(normalizeEmail(account.email)) || 1) : 1;
            return sum + limit / share;
        }, 0);

        const dailyLimit = positiveNumber(campaign?.daily_limit);
        const dailyMaxLeads = positiveNumber(campaign?.daily_max_leads);
        const stepCount = Array.isArray(campaign?.sequences?.[0]?.steps) ? campaign.sequences[0].steps.length : 0;
        const steps = stepCount || DEFAULT_STEPS;
        const sendsPerDay = Math.floor(dailyLimit ? Math.min(inboxCapacity, dailyLimit) : inboxCapacity);
        const volumeNewLeads = Math.floor(sendsPerDay / steps);
        const newLeadsPerDay = dailyMaxLeads ? Math.min(dailyMaxLeads, volumeNewLeads) : volumeNewLeads;
        const limitedBy = dailyMaxLeads && dailyMaxLeads <= volumeNewLeads
            ? 'daily_max_leads'
            : dailyLimit && dailyLimit <= inboxCapacity
                ? 'campaign_daily_limit'
                : 'inboxes';
        const scheduleDays = campaignScheduleDays(campaign);
        const runwayDays = active && newLeadsPerDay > 0 ? counts.notContacted / newLeadsPerDay : null;

        if (active && !inboxEmails.length) {
            warnings.push(`"${campaign.name}" has no inboxes assigned in Instantly.`);
        } else if (active && !activeInboxes.length) {
            warnings.push(`"${campaign.name}" has ${inboxEmails.length} inbox(es) assigned but none are active.`);
        }
        if (active && !stepCount) {
            warnings.push(`"${campaign.name}" sequence steps weren't readable; assumed ${DEFAULT_STEPS}.`);
        }

        rows.push({
            id,
            name: String(campaign?.name || id),
            status: CAMPAIGN_STATUS_LABELS[status] || String(campaign?.status ?? 'unknown'),
            active,
            inboxes: activeInboxes.length,
            sharedInboxes,
            sendsPerDay: active ? sendsPerDay : 0,
            dailyLimit,
            dailyMaxLeads,
            steps,
            newLeadsPerDay: active ? newLeadsPerDay : 0,
            limitedBy: active ? limitedBy : null,
            backlog: counts.notContacted,
            inSequence: counts.inSequence,
            scheduleDays,
            runwayDays: roundDays(runwayDays),
            runsDryOn: runwayDays === null ? null : addSendingDays(now, runwayDays, scheduleDays)
        });
    }

    rows.sort((a, b) => Number(b.active) - Number(a.active) || b.backlog - a.backlog);

    const running = rows.filter((row) => row.active && row.newLeadsPerDay > 0);
    const newLeadsPerDay = running.reduce((sum, row) => sum + row.newLeadsPerDay, 0);
    const backlogTotal = running.reduce((sum, row) => sum + row.backlog, 0);
    const scheduleDays = [...new Set(running.flatMap((row) => row.scheduleDays))].sort();
    const days = scheduleDays.length ? scheduleDays : DEFAULT_SCHEDULE_DAYS;
    const backlogDays = newLeadsPerDay > 0 ? backlogTotal / newLeadsPerDay : null;
    const reserveDays = newLeadsPerDay > 0 ? reserve.verified / newLeadsPerDay : null;
    const totalDays = backlogDays === null ? null : backlogDays + reserveDays;
    const uniqueInboxes = new Set(running.flatMap((row) => [...campaignInboxes.get(row.id)]
        .filter((email) => isActiveAccount(accountByEmail.get(email)))));

    const pausedBacklog = rows.filter((row) => !row.active).reduce((sum, row) => sum + row.backlog, 0);
    if (!running.length) warnings.push('No active campaign has sending capacity, so there is no runway to estimate.');

    return {
        totals: {
            activeCampaigns: running.length,
            inboxes: uniqueInboxes.size,
            sendsPerDay: running.reduce((sum, row) => sum + row.sendsPerDay, 0),
            newLeadsPerDay,
            backlog: backlogTotal,
            inSequence: rows.filter((row) => row.active).reduce((sum, row) => sum + row.inSequence, 0),
            pausedBacklog,
            scheduleDays: days,
            backlogRunwayDays: roundDays(backlogDays),
            backlogRunsDryOn: backlogDays === null ? null : addSendingDays(now, backlogDays, days),
            reserve: {
                verified: reserve.verified,
                withFirstLine: reserve.withFirstLine,
                extraDays: roundDays(reserveDays)
            },
            totalRunwayDays: roundDays(totalDays),
            totalRunsDryOn: totalDays === null ? null : addSendingDays(now, totalDays, days)
        },
        campaigns: rows,
        warnings
    };
}

async function loadBacklog(pool, agencyId, sqlClientId) {
    const { rows } = await pool.query(
        `SELECT
            ic.instantly_campaign_id,
            COUNT(*) FILTER (
                WHERE cic.timestamp_last_contact IS NULL AND COALESCE(cic.lead_status, 1) = 1
            )::int AS not_contacted,
            COUNT(*) FILTER (
                WHERE cic.timestamp_last_contact IS NOT NULL AND cic.lead_status = 1
            )::int AS in_sequence,
            MAX(cic.last_synced_at) AS last_synced_at
         FROM instantly_campaigns ic
         JOIN contact_instantly_campaigns cic ON cic.campaign_id = ic.id AND cic.active = TRUE
         WHERE ic.agency_id = $1 AND ic.client_id = $2
         GROUP BY ic.instantly_campaign_id`,
        [agencyId, sqlClientId]
    );
    const backlog = new Map();
    let leadsSyncedAt = null;
    for (const row of rows) {
        backlog.set(String(row.instantly_campaign_id), {
            notContacted: row.not_contacted,
            inSequence: row.in_sequence
        });
        if (row.last_synced_at && (!leadsSyncedAt || row.last_synced_at > leadsSyncedAt)) {
            leadsSyncedAt = row.last_synced_at;
        }
    }
    return { backlog, leadsSyncedAt };
}

/** Verified leads in the lead bank that were never in an Instantly campaign. */
async function loadReserve(pool, agencyId, sqlClientId) {
    const { rows } = await pool.query(
        `SELECT
            COUNT(*)::int AS verified,
            COUNT(*) FILTER (
                WHERE c.personalization_first_line IS NOT NULL AND BTRIM(c.personalization_first_line) <> ''
            )::int AS with_first_line
         FROM contacts c
         WHERE c.agency_id = $1 AND c.client_id = $2
           AND c.email_status = 'valid'
           AND c.last_contacted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM contact_instantly_campaigns cic WHERE cic.contact_id = c.id)`,
        [agencyId, sqlClientId]
    );
    return { verified: rows[0]?.verified || 0, withFirstLine: rows[0]?.with_first_line || 0 };
}

async function computeForClient({ pool, agencyId, sqlClientId, instantlyKey }) {
    const [listedCampaigns, accounts, { backlog, leadsSyncedAt }, reserve] = await Promise.all([
        fetchInstantlyCampaigns(instantlyKey),
        fetchInstantlyAccounts(instantlyKey),
        loadBacklog(pool, agencyId, sqlClientId),
        loadReserve(pool, agencyId, sqlClientId)
    ]);

    // Some campaigns come back without their settings (stored payloads show the
    // same stub); fetch those one by one so capacity isn't silently zero.
    const campaigns = [];
    for (const campaign of listedCampaigns) {
        const needsDetail = Number(campaign?.status) === 1 && campaign?.id && !Array.isArray(campaign?.sequences);
        campaigns.push(needsDetail
            ? await instantlyRequest({ apiKey: instantlyKey, path: `/api/v2/campaigns/${encodeURIComponent(campaign.id)}` })
            : campaign);
    }

    // Resolve tags only for campaigns that matter (running, or still holding leads).
    const relevant = campaigns.filter((campaign) => Number(campaign?.status) === 1 || backlog.has(String(campaign?.id)));
    const tagIds = [...new Set(relevant.flatMap((campaign) => (
        Array.isArray(campaign?.email_tag_list) ? campaign.email_tag_list.map(String) : []
    )))];
    const taggedEmails = new Map();
    for (const tagId of tagIds) {
        const tagged = await fetchInstantlyAccounts(instantlyKey, { tagIds: [tagId] });
        taggedEmails.set(tagId, tagged.map((account) => account?.email).filter(Boolean));
    }

    return {
        ...computeSendingRunway({ campaigns, accounts, taggedEmails, backlog, reserve }),
        computedAt: new Date().toISOString(),
        leadsSyncedAt: leadsSyncedAt ? new Date(leadsSyncedAt).toISOString() : null
    };
}

/**
 * Cached runway for one client. `refresh` bypasses the cache; concurrent
 * callers share one computation.
 */
export async function loadSendingRunway({ pool, agencyId, sqlClientId, instantlyKey, refresh = false }) {
    const key = `${agencyId}:${sqlClientId}`;
    const cached = cache.get(key);
    if (!refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    if (inFlight.has(key)) return inFlight.get(key);
    const promise = computeForClient({ pool, agencyId, sqlClientId, instantlyKey })
        .then((value) => {
            cache.set(key, { at: Date.now(), value });
            return value;
        })
        .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
}
