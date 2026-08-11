import crypto from 'crypto';
import { pool } from '../config/db.js';
import { getOrCreateClient, getClientRowBySlug, listClientsWithInstantlyKey } from './db/queries.js';
import {
    cancelNonInterestedAutoResponderDrafts,
    createInterestedAutoResponderDraftFromEvent,
    maybeCreatePostAutoresponderFollowUpDraft
} from './interestedAutoResponder.js';

const INSTANTLY_API_BASE_URL = 'https://api.instantly.ai';
const INSTANTLY_SYNC_PAGE_LIMIT = Math.max(1, Math.min(parseInt(process.env.INSTANTLY_SYNC_PAGE_LIMIT || '100', 10) || 100, 100));
const INSTANTLY_REQUEST_TIMEOUT_MS = Math.max(parseInt(process.env.INSTANTLY_REQUEST_TIMEOUT_MS || '20000', 10) || 20000, 1000);
const INSTANTLY_RATE_LIMIT_PER_SECOND = Math.max(parseInt(process.env.INSTANTLY_RATE_LIMIT_PER_SECOND || '20', 10) || 20, 1);
const INSTANTLY_MAX_RETRIES = Math.max(parseInt(process.env.INSTANTLY_MAX_RETRIES || '4', 10) || 4, 0);
const INSTANTLY_RETRY_BASE_DELAY_MS = Math.max(parseInt(process.env.INSTANTLY_RETRY_BASE_DELAY_MS || '1000', 10) || 1000, 100);
const INSTANTLY_SYNC_PROGRESS_BATCH_SIZE = Math.max(parseInt(process.env.INSTANTLY_SYNC_PROGRESS_BATCH_SIZE || '25', 10) || 25, 1);
const INSTANTLY_REPLY_INTEREST_RECONCILE_ENABLED = false;
const INSTANTLY_REPLY_INTEREST_RECONCILE_DELAY_MS = 10_000;
const INSTANTLY_REPLY_INTEREST_RECONCILE_WINDOW_MS = 10_000;
const INSTANTLY_INTEREST_STATUS_WEBHOOK_EVENT_TYPES = [
    'lead_interested',
    'lead_meeting_booked',
    'lead_meeting_completed',
    'lead_closed',
    'lead_out_of_office',
    'lead_not_interested',
    'lead_wrong_person',
    'lead_neutral',
    'lead_no_show',
    'bad fit',
    'risky'
];
const INSTANTLY_MIN_REQUEST_INTERVAL_MS = Math.max(Math.ceil(1000 / INSTANTLY_RATE_LIMIT_PER_SECOND), 1);
const instantlyNextRequestAtByKey = new Map();
const instantlyAbortControllersByRunId = new Map();
const replyInterestReconcileTimers = new Map();

const clientStateCache = new Map();
const CLIENT_STATE_CACHE_TTL_MS = 60_000;

const LEAD_STATUS_LABELS = new Map([
    [1, 'active'],
    [2, 'paused'],
    [3, 'completed'],
    [-1, 'bounced'],
    [-2, 'unsubscribed'],
    [-3, 'skipped']
]);

const INTEREST_STATUS_LABELS = new Map([
    [4, 'won'],
    [3, 'meeting_completed'],
    [2, 'meeting_booked'],
    [1, 'interested'],
    [0, 'out_of_office'],
    [-1, 'not_interested'],
    [-2, 'wrong_person'],
    [-3, 'lost'],
    [-4, 'no_show']
]);

function normalizeEmail(email) {
    if (!email || typeof email !== 'string') return null;
    const normalized = email.trim().toLowerCase();
    return normalized || null;
}

function asNullableText(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized || null;
}

function asNullableInt(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function asNullableTimestamp(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asJsonObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeDomain(value) {
    const raw = asNullableText(value);
    if (!raw) return null;

    let normalized = raw.toLowerCase();
    normalized = normalized.replace(/^[a-z]+:\/\//, '');
    normalized = normalized.replace(/^www\./, '');
    normalized = normalized.split('/')[0];
    normalized = normalized.split('?')[0];
    normalized = normalized.split('#')[0];
    normalized = normalized.replace(/:\d+$/, '');
    return normalized || null;
}

function extractEmailDomain(email) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail || !normalizedEmail.includes('@')) return null;
    return normalizeDomain(normalizedEmail.split('@')[1]);
}

function extractLeadFirstName(lead) {
    return asNullableText(
        lead?.first_name
        || lead?.firstName
        || lead?.fname
    );
}

function extractLeadLastName(lead) {
    return asNullableText(
        lead?.last_name
        || lead?.lastName
        || lead?.lname
    );
}

function extractLeadFullName(lead) {
    const direct = asNullableText(
        lead?.full_name
        || lead?.fullName
        || lead?.name
        || lead?.lead_name
    );
    if (direct) return direct;

    const firstName = extractLeadFirstName(lead);
    const lastName = extractLeadLastName(lead);
    const combined = [firstName, lastName].filter(Boolean).join(' ').trim();
    if (combined) return combined;

    return null;
}

function extractLeadDomain(lead) {
    const candidates = [
        lead?.company_domain,
        lead?.companyDomain,
        lead?.website,
        lead?.website_url,
        lead?.company_website,
        lead?.companyWebsite,
        lead?.domain,
        lead?.company_url,
        lead?.company?.domain,
        lead?.company?.website
    ];

    for (const candidate of candidates) {
        const normalized = normalizeDomain(candidate);
        if (normalized) return normalized;
    }

    return extractEmailDomain(lead?.email);
}

function extractLeadCustomProperties(lead) {
    const payload = asJsonObject(lead?.payload);
    const custom = {};
    const reservedKeys = new Set([
        'email',
        'domain',
        'firstName',
        'lastName',
        'first_name',
        'last_name'
    ]);

    for (const [key, value] of Object.entries(payload)) {
        if (!key || reservedKeys.has(key) || value === null || value === undefined) continue;
        const keyText = String(key).trim();
        if (!keyText) continue;
        custom[keyText] = value;
    }

    return custom;
}

function buildSyntheticInstantlyDomain(lead) {
    const key = asNullableText(lead?.id)
        || normalizeEmail(lead?.email)
        || extractLeadFullName(lead)
        || crypto.randomUUID();
    const suffix = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
    return `instantly-${suffix}.invalid`;
}

function buildInstantlyRoleType(lead) {
    const key = asNullableText(lead?.id)
        || normalizeEmail(lead?.email)
        || extractLeadFullName(lead)
        || crypto.randomUUID();
    const suffix = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
    return `instantly:${suffix}`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerInstantlyAbortController(syncRunId, controller) {
    if (!syncRunId) return;
    const key = String(syncRunId);
    const controllers = instantlyAbortControllersByRunId.get(key) || new Set();
    controllers.add(controller);
    instantlyAbortControllersByRunId.set(key, controllers);
}

function unregisterInstantlyAbortController(syncRunId, controller) {
    if (!syncRunId) return;
    const key = String(syncRunId);
    const controllers = instantlyAbortControllersByRunId.get(key);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) {
        instantlyAbortControllersByRunId.delete(key);
    }
}

function abortInstantlyRequestsForRun(syncRunId) {
    if (!syncRunId) return;
    const controllers = instantlyAbortControllersByRunId.get(String(syncRunId));
    if (!controllers) return;
    for (const controller of controllers) {
        try {
            controller.abort();
        } catch {
            // ignore controller abort failures
        }
    }
}

function extractItems(payload) {
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.leads)) return payload.leads;
    if (Array.isArray(payload?.campaigns)) return payload.campaigns;
    if (Array.isArray(payload)) return payload;
    return [];
}

function nextStartingAfter(payload) {
    return payload?.next_starting_after
        || payload?.pagination?.next_starting_after
        || null;
}

function mapLeadStatusLabel(status) {
    if (status === null || status === undefined) return null;
    return LEAD_STATUS_LABELS.get(Number(status)) || null;
}

function mapInterestStatusLabel(status) {
    if (status === null || status === undefined) return null;
    return INTEREST_STATUS_LABELS.get(Number(status)) || null;
}

function classifyReplyCategory(eventType, interestStatus = null) {
    const normalizedType = asNullableText(eventType)?.toLowerCase();

    if (normalizedType === 'lead_interested' || normalizedType === 'lead_meeting_booked' || normalizedType === 'lead_meeting_completed' || normalizedType === 'lead_closed') {
        return 'positive';
    }
    if (normalizedType === 'lead_not_interested' || normalizedType === 'lead_wrong_person') {
        return 'negative';
    }
    if (normalizedType === 'lead_neutral' || normalizedType === 'lead_out_of_office' || normalizedType === 'lead_no_show') {
        return 'neutral';
    }
    if (normalizedType === 'reply_received') {
        if (interestStatus === null || interestStatus === undefined) return 'other';
    }

    const numericInterestStatus = asNullableInt(interestStatus);
    if (numericInterestStatus === null) return null;
    if (numericInterestStatus >= 1) return 'positive';
    if (numericInterestStatus <= -1) return 'negative';
    if (numericInterestStatus === 0) return 'neutral';
    return 'other';
}

function buildEventFingerprint(event) {
    const base = [
        asNullableText(event?.event_type) || '',
        asNullableTimestamp(event?.timestamp) || '',
        asNullableText(event?.campaign_id) || '',
        normalizeEmail(event?.lead_email) || '',
        asNullableText(event?.lead_id || event?.instantly_lead_id) || '',
        asNullableText(event?.unibox_url) || '',
        asNullableText(event?.step) || '',
        asNullableText(event?.variant) || ''
    ].join('|');
    return crypto.createHash('sha256').update(base).digest('hex');
}

function extractReplyToUuid(event) {
    return asNullableText(
        event?.reply_to_uuid
        || event?.email_id
        || event?.uuid
        || event?.id
        || event?.email?.id
        || event?.data?.reply_to_uuid
        || event?.data?.email_id
        || event?.data?.uuid
        || event?.data?.id
    );
}

class InstantlyRequestError extends Error {
    constructor(message, { statusCode = null, retryAfterMs = null, retryable = false, cause = null } = {}) {
        super(message);
        this.name = 'InstantlyRequestError';
        this.statusCode = statusCode;
        this.retryAfterMs = retryAfterMs;
        this.retryable = retryable;
        this.cause = cause;
    }
}

class InstantlySyncCancelledError extends Error {
    constructor(message = 'Instantly sync cancelled.') {
        super(message);
        this.name = 'InstantlySyncCancelledError';
    }
}

async function waitForInstantlyRateLimitSlot(apiKey, syncRunId = null) {
    const now = Date.now();
    const nextAvailableAt = Math.max(instantlyNextRequestAtByKey.get(apiKey) || 0, now);
    instantlyNextRequestAtByKey.set(apiKey, nextAvailableAt + INSTANTLY_MIN_REQUEST_INTERVAL_MS);
    const waitMs = nextAvailableAt - now;
    if (waitMs > 0) {
        await sleepWithCancellation(waitMs, syncRunId);
    }
}

function computeRetryDelayMs(error, attempt) {
    if (error?.retryAfterMs && error.retryAfterMs > 0) {
        return error.retryAfterMs;
    }

    const jitterMs = Math.floor(Math.random() * 250);
    return Math.min(INSTANTLY_RETRY_BASE_DELAY_MS * (2 ** attempt) + jitterMs, 30000);
}

function normalizeSyncRunRow(row) {
    if (!row) return null;
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    return {
        id: Number(row.id),
        agencyId: row.agency_id,
        clientId: Number(row.client_id),
        triggerSource: row.trigger_source,
        status: row.status,
        progressMessage: row.progress_message,
        totalCampaigns: Number(row.total_campaigns || 0),
        campaignsCompleted: Number(row.campaigns_completed || 0),
        currentCampaignId: row.current_campaign_id,
        currentCampaignName: row.current_campaign_name,
        totalLeadsSeen: Number(row.total_leads_seen || 0),
        matchedLeads: Number(row.matched_leads || 0),
        unmatchedLeads: Number(row.unmatched_leads || 0),
        error: row.error,
        metadata,
        phase: asNullableText(metadata.phase),
        currentCampaignFetchedLeads: Number.isFinite(Number(metadata.currentCampaignFetchedLeads))
            ? Number(metadata.currentCampaignFetchedLeads)
            : null,
        currentCampaignLeadTotal: Number.isFinite(Number(metadata.currentCampaignLeadTotal))
            ? Number(metadata.currentCampaignLeadTotal)
            : null,
        currentCampaignProcessedLeads: Number.isFinite(Number(metadata.currentCampaignProcessedLeads))
            ? Number(metadata.currentCampaignProcessedLeads)
            : null,
        currentCampaignMatchedLeads: Number.isFinite(Number(metadata.currentCampaignMatchedLeads))
            ? Number(metadata.currentCampaignMatchedLeads)
            : null,
        currentCampaignUnmatchedLeads: Number.isFinite(Number(metadata.currentCampaignUnmatchedLeads))
            ? Number(metadata.currentCampaignUnmatchedLeads)
            : null,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        updatedAt: row.updated_at
    };
}

function mergeMetadataPatch(existingMetadata, patchMetadata) {
    return {
        ...(existingMetadata && typeof existingMetadata === 'object' ? existingMetadata : {}),
        ...(patchMetadata && typeof patchMetadata === 'object' ? patchMetadata : {})
    };
}

function deriveSnapshotFromLead(lead, syncedAt, customInterestLabels = null) {
    const leadStatus = asNullableInt(lead?.status);
    const interestStatus = asNullableInt(lead?.lt_interest_status);
    const mappedInterestLabel = mapInterestStatusLabel(interestStatus);
    const customInterestLabel = (interestStatus !== null && customInterestLabels instanceof Map)
        ? (customInterestLabels.get(interestStatus) || null)
        : null;
    return {
        instantlyLeadId: asNullableText(lead?.id),
        addedAt: asNullableTimestamp(
            lead?.timestamp_created
            || lead?.createdAt
            || lead?.created_at
            || lead?.created
            || lead?.created_at_utc
        ),
        active: true,
        lastSeenAt: syncedAt,
        leadStatus,
        leadStatusLabel: mapLeadStatusLabel(leadStatus),
        interestStatus,
        interestStatusLabel: mappedInterestLabel || customInterestLabel || null,
        verificationStatus: asNullableInt(lead?.verification_status),
        emailOpenCount: Number.parseInt(lead?.email_open_count || 0, 10) || 0,
        emailReplyCount: Number.parseInt(lead?.email_reply_count || 0, 10) || 0,
        emailClickCount: Number.parseInt(lead?.email_click_count || 0, 10) || 0,
        timestampLastContact: asNullableTimestamp(lead?.timestamp_last_contact),
        timestampLastOpen: asNullableTimestamp(lead?.timestamp_last_open),
        timestampLastReply: asNullableTimestamp(lead?.timestamp_last_reply),
        timestampLastInterestChange: asNullableTimestamp(lead?.timestamp_last_interest_change),
        timestampLastClick: asNullableTimestamp(lead?.timestamp_last_click),
        lastContactedFrom: asNullableText(lead?.last_contacted_from),
        lastStepFrom: asNullableText(lead?.last_step_from),
        lastStepId: asNullableText(lead?.last_step_id),
        lastStepTimestampExecuted: asNullableTimestamp(lead?.last_step_timestamp_executed),
        statusSummary: asJsonObject(lead?.status_summary),
        statusSummarySubseq: asJsonObject(lead?.status_summary_subseq),
        rawLeadPayload: lead && typeof lead === 'object' ? lead : {},
        lastReplyCategory: classifyReplyCategory(null, interestStatus),
        lastEventType: 'state_sync',
        lastBounceAt: leadStatus === -1 ? asNullableTimestamp(lead?.timestamp_last_touch || lead?.timestamp_updated) : null,
        lastUnsubscribeAt: leadStatus === -2 ? asNullableTimestamp(lead?.timestamp_last_touch || lead?.timestamp_updated) : null,
        lastSyncedAt: syncedAt
    };
}

function buildEventPatch(event, eventTimestamp) {
    const eventType = asNullableText(event?.event_type)?.toLowerCase() || 'unknown';
    const patch = {
        leadStatus: null,
        leadStatusLabel: null,
        interestStatus: null,
        interestStatusLabel: null,
        lastReplyCategory: classifyReplyCategory(eventType),
        lastEventType: eventType,
        timestampLastContact: null,
        timestampLastOpen: null,
        timestampLastReply: null,
        timestampLastClick: null,
        timestampLastInterestChange: null,
        lastBounceAt: null,
        lastUnsubscribeAt: null,
        openDelta: 0,
        replyDelta: 0,
        clickDelta: 0
    };

    if (eventType === 'email_sent') patch.timestampLastContact = eventTimestamp;
    if (eventType === 'email_opened') {
        patch.timestampLastOpen = eventTimestamp;
        patch.openDelta = 1;
    }
    if (eventType === 'email_link_clicked') {
        patch.timestampLastClick = eventTimestamp;
        patch.clickDelta = 1;
    }
    if (eventType === 'reply_received') {
        patch.timestampLastReply = eventTimestamp;
        patch.replyDelta = 1;
    }
    if (eventType === 'email_bounced') {
        patch.leadStatus = -1;
        patch.leadStatusLabel = 'bounced';
        patch.lastBounceAt = eventTimestamp;
    }
    if (eventType === 'lead_unsubscribed') {
        patch.leadStatus = -2;
        patch.leadStatusLabel = 'unsubscribed';
        patch.lastUnsubscribeAt = eventTimestamp;
    }

    const interestByEventType = {
        lead_interested: 1,
        lead_meeting_booked: 2,
        lead_meeting_completed: 3,
        lead_closed: 4,
        lead_out_of_office: 0,
        lead_not_interested: -1,
        lead_wrong_person: -2,
        lead_neutral: 0,
        lead_no_show: -4,
        'bad fit': -1,
        risky: -1
    };

    if (Object.prototype.hasOwnProperty.call(interestByEventType, eventType)) {
        patch.interestStatus = interestByEventType[eventType];
        patch.interestStatusLabel = mapInterestStatusLabel(patch.interestStatus);
        patch.timestampLastInterestChange = eventTimestamp;
        patch.timestampLastReply = patch.timestampLastReply || eventTimestamp;
        patch.lastReplyCategory = classifyReplyCategory(eventType, patch.interestStatus);
    }

    return patch;
}

async function sleepWithCancellation(ms, syncRunId = null) {
    if (!syncRunId) {
        await sleep(ms);
        return;
    }

    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        await assertSyncRunNotCancelled(syncRunId);
        await sleep(Math.min(250, Math.max(deadline - Date.now(), 0)));
    }
}

async function instantlyRequest({ apiKey, path, method = 'GET', body, syncRunId = null }) {
    for (let attempt = 0; attempt <= INSTANTLY_MAX_RETRIES; attempt += 1) {
        await assertSyncRunNotCancelled(syncRunId);
        await waitForInstantlyRateLimitSlot(apiKey, syncRunId);

        const controller = new AbortController();
        registerInstantlyAbortController(syncRunId, controller);
        const timeoutId = setTimeout(() => controller.abort(), INSTANTLY_REQUEST_TIMEOUT_MS);
        let cancellationWatchId = null;

        if (syncRunId) {
            cancellationWatchId = setInterval(() => {
                shouldStopInstantlySyncRun(syncRunId)
                    .then((stopRequested) => {
                        if (stopRequested) {
                            controller.abort();
                        }
                    })
                    .catch(() => {
                        // ignore cancellation polling errors during request teardown
                    });
            }, 250);
        }

        try {
            const response = await fetch(`${INSTANTLY_API_BASE_URL}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    Accept: 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {})
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });

            if (!response.ok) {
                const message = await response.text().catch(() => '');
                const retryAfterHeader = response.headers.get('retry-after');
                const retryAfterSeconds = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : null;
                const retryAfterMs = Number.isFinite(retryAfterSeconds) ? Math.max(Math.ceil(retryAfterSeconds * 1000), 0) : null;
                const retryable = response.status === 429 || response.status >= 500;
                const error = new InstantlyRequestError(
                    `Instantly API ${method} ${path} failed (${response.status}): ${message}`,
                    {
                        statusCode: response.status,
                        retryAfterMs,
                        retryable
                    }
                );

                if (!retryable || attempt === INSTANTLY_MAX_RETRIES) {
                    throw error;
                }

                await sleepWithCancellation(computeRetryDelayMs(error, attempt), syncRunId);
                continue;
            }

            if (response.status === 204) return null;
            return response.json();
        } catch (error) {
            const timedOut = error?.name === 'AbortError';
            if (timedOut && syncRunId && await shouldStopInstantlySyncRun(syncRunId)) {
                throw new InstantlySyncCancelledError();
            }
            const retryable = timedOut || error instanceof TypeError || error?.retryable === true;
            const wrappedError = error instanceof InstantlyRequestError
                ? error
                : new InstantlyRequestError(
                    timedOut
                        ? `Instantly API ${method} ${path} timed out after ${INSTANTLY_REQUEST_TIMEOUT_MS}ms`
                        : `Instantly API ${method} ${path} request failed: ${error?.message || error}`,
                    {
                        retryable,
                        cause: error
                    }
                );

            if (!wrappedError.retryable || attempt === INSTANTLY_MAX_RETRIES) {
                throw wrappedError;
            }

            await sleepWithCancellation(computeRetryDelayMs(wrappedError, attempt), syncRunId);
        } finally {
            clearTimeout(timeoutId);
            if (cancellationWatchId) {
                clearInterval(cancellationWatchId);
            }
            unregisterInstantlyAbortController(syncRunId, controller);
        }
    }

    throw new InstantlyRequestError(`Instantly API ${method} ${path} failed after ${INSTANTLY_MAX_RETRIES + 1} attempts`);
}

function resolveInstantlyCampaignIdFromPayload(campaign) {
    return asNullableText(campaign?.id || campaign?.campaignId || campaign?.uuid || campaign?._id);
}

function filterCampaignsForSync(campaigns, instantlyCampaignId) {
    const targetId = asNullableText(instantlyCampaignId);
    if (!targetId) return campaigns;
    return campaigns.filter((campaign) => resolveInstantlyCampaignIdFromPayload(campaign) === targetId);
}

async function fetchInstantlyCampaigns(apiKey, { syncRunId = null } = {}) {
    const payload = await instantlyRequest({
        apiKey,
        path: '/api/v2/campaigns',
        method: 'GET',
        syncRunId
    });
    return extractItems(payload);
}

async function fetchInstantlyAccounts(apiKey, { syncRunId = null } = {}) {
    const rows = [];
    let startingAfter = null;

    while (true) {
        const params = new URLSearchParams();
        params.set('limit', String(INSTANTLY_SYNC_PAGE_LIMIT));
        if (startingAfter) {
            params.set('starting_after', startingAfter);
        }

        const payload = await instantlyRequest({
            apiKey,
            path: `/api/v2/accounts?${params.toString()}`,
            method: 'GET',
            syncRunId
        });

        const items = extractItems(payload);
        rows.push(...items);

        const next = nextStartingAfter(payload);
        if (!next) break;
        startingAfter = next;
    }

    return rows;
}

async function upsertEmailAccounts(db, rows) {
    if (!rows.length) return 0;

    await db.query(
        `WITH input AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS x(
                agency_id TEXT,
                client_id BIGINT,
                email TEXT,
                first_name TEXT,
                last_name TEXT,
                provider_code INTEGER,
                signature TEXT,
                instantly_workspace_id TEXT,
                raw_payload JSONB,
                last_synced_at TIMESTAMPTZ
            )
        )
        INSERT INTO email_accounts (
            agency_id, client_id, email, first_name, last_name, provider_code,
            signature, instantly_workspace_id, raw_payload, last_synced_at, updated_at
        )
        SELECT
            agency_id, client_id, LOWER(email), first_name, last_name, provider_code,
            signature, instantly_workspace_id, raw_payload, last_synced_at, NOW()
        FROM input
        ON CONFLICT (client_id, email)
        DO UPDATE SET
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            provider_code = EXCLUDED.provider_code,
            signature = EXCLUDED.signature,
            instantly_workspace_id = EXCLUDED.instantly_workspace_id,
            raw_payload = EXCLUDED.raw_payload,
            last_synced_at = EXCLUDED.last_synced_at,
            updated_at = NOW()`,
        [JSON.stringify(rows)]
    );

    return rows.length;
}

async function fetchCampaignLeads(apiKey, instantlyCampaignId, { syncRunId = null, logger = () => {}, onProgress = null } = {}) {
    const rows = [];
    let startingAfter = null;

    while (true) {
        await assertSyncRunNotCancelled(syncRunId);
        let page = null;
        let lastError = null;
        const requestBodies = [
            { campaign: instantlyCampaignId, limit: INSTANTLY_SYNC_PAGE_LIMIT, starting_after: startingAfter },
            { campaign_id: instantlyCampaignId, limit: INSTANTLY_SYNC_PAGE_LIMIT, starting_after: startingAfter }
        ].map((candidate) => Object.fromEntries(
            Object.entries(candidate).filter(([, value]) => value !== null && value !== undefined && value !== '')
        ));

        for (const body of requestBodies) {
            await assertSyncRunNotCancelled(syncRunId);
            try {
                page = await instantlyRequest({
                    apiKey,
                    path: '/api/v2/leads/list',
                    method: 'POST',
                    body,
                    syncRunId
                });
                break;
            } catch (error) {
                lastError = error;
            }
        }

        if (!page) {
            throw lastError;
        }

        const items = extractItems(page);
        rows.push(...items);

        const next = nextStartingAfter(page);
        logger(`Fetched ${items.length} leads for campaign ${instantlyCampaignId}${next ? ` (next=${next})` : ''}`);
        if (typeof onProgress === 'function') {
            await onProgress({
                fetchedLeads: rows.length,
                lastPageSize: items.length,
                hasMore: Boolean(next)
            });
        }
        if (!next) break;
        startingAfter = next;
    }

    return rows;
}

async function fetchInstantlyLeadById(apiKey, leadId, { syncRunId = null } = {}) {
    const normalizedLeadId = asNullableText(leadId);
    if (!normalizedLeadId) return null;
    return instantlyRequest({
        apiKey,
        path: `/api/v2/leads/${encodeURIComponent(normalizedLeadId)}`,
        method: 'GET',
        syncRunId
    });
}

async function fetchInstantlyLeadForReplyReconcile(apiKey, { instantlyCampaignId, leadId, email }) {
    const normalizedLeadId = asNullableText(leadId);
    if (normalizedLeadId) {
        try {
            return await fetchInstantlyLeadById(apiKey, normalizedLeadId);
        } catch (error) {
            if (!(error instanceof InstantlyRequestError) || (error.statusCode && error.statusCode !== 404)) {
                throw error;
            }
        }
    }

    const normalizedEmail = normalizeEmail(email);
    const normalizedCampaignId = asNullableText(instantlyCampaignId);
    if (!normalizedEmail || !normalizedCampaignId) return null;

    const payload = await instantlyRequest({
        apiKey,
        path: '/api/v2/leads/list',
        method: 'POST',
        body: {
            campaign: normalizedCampaignId,
            contacts: [normalizedEmail],
            limit: 1
        }
    });
    const items = extractItems(payload);
    return items[0] || null;
}

export function isInstantlyReplyWebhookEvent(eventType) {
    const normalized = asNullableText(eventType)?.toLowerCase();
    return normalized === 'reply_received' || normalized === 'reply' || normalized === 'replied';
}

export function shouldApplyInterestStatusFromReplyReconcile({ previousInterestStatus, nextInterestStatus }) {
    const prior = asNullableInt(previousInterestStatus);
    const next = asNullableInt(nextInterestStatus);
    if (prior === next) return false;
    return mapInterestStatusToEventType(next) !== null;
}

async function publishInstantlySyncProgress(runId, patch = {}) {
    if (!runId) return null;

    const {
        phase,
        currentCampaignFetchedLeads,
        currentCampaignLeadTotal,
        currentCampaignProcessedLeads,
        currentCampaignMatchedLeads,
        currentCampaignUnmatchedLeads,
        metadata: patchMetadata,
        ...rest
    } = patch;

    const needsMetadataMerge = [
        phase,
        currentCampaignFetchedLeads,
        currentCampaignLeadTotal,
        currentCampaignProcessedLeads,
        currentCampaignMatchedLeads,
        currentCampaignUnmatchedLeads,
        patchMetadata
    ].some((value) => value !== undefined);

    if (!needsMetadataMerge) {
        return updateInstantlySyncRun(runId, rest);
    }

    const currentRow = await getInstantlySyncRunRowById(runId);
    const metadata = mergeMetadataPatch(currentRow?.metadata, {
        ...(phase !== undefined ? { phase } : {}),
        ...(currentCampaignFetchedLeads !== undefined ? { currentCampaignFetchedLeads } : {}),
        ...(currentCampaignLeadTotal !== undefined ? { currentCampaignLeadTotal } : {}),
        ...(currentCampaignProcessedLeads !== undefined ? { currentCampaignProcessedLeads } : {}),
        ...(currentCampaignMatchedLeads !== undefined ? { currentCampaignMatchedLeads } : {}),
        ...(currentCampaignUnmatchedLeads !== undefined ? { currentCampaignUnmatchedLeads } : {}),
        ...(patchMetadata && typeof patchMetadata === 'object' ? patchMetadata : {})
    });

    return updateInstantlySyncRun(runId, {
        ...rest,
        metadata
    });
}

async function resolveClientState(agencyId, clientSlug) {
    const normalizedSlug = String(clientSlug || '').trim();
    const cacheKey = `${agencyId}::${normalizedSlug}`;
    const cached = clientStateCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CLIENT_STATE_CACHE_TTL_MS) {
        return cached.value;
    }

    const bySlug = normalizedSlug ? await getClientRowBySlug(agencyId, normalizedSlug) : null;
    const clientId = bySlug?.id ?? (await getOrCreateClient(agencyId, normalizedSlug || clientSlug));
    const result = await pool.query(
        `SELECT id, name, instantly_workspace_id, instantly_webhook_id, instantly_webhook_secret,
                instantly_webhook_url, instantly_webhook_status, instantly_sync_enabled,
                instantly_last_synced_at, instantly_last_sync_error
         FROM clients
         WHERE id = $1 AND agency_id = $2`,
        [clientId, agencyId]
    );
    const value = result.rows[0] || null;
    clientStateCache.set(cacheKey, { value, ts: Date.now() });
    return value;
}

export async function validateInstantlyWebhookSecret(agencyId, clientSlug, secret) {
    const clientState = await resolveClientState(agencyId, clientSlug);
    if (!clientState) return { valid: false, statusCode: 404, message: 'Client not found.' };
    const expectedSecret = asNullableText(clientState.instantly_webhook_secret);
    if (!expectedSecret || expectedSecret !== secret) return { valid: false, statusCode: 401, message: 'Invalid Instantly webhook secret.' };
    return { valid: true };
}

async function createInstantlySyncRun({ agencyId, clientId, triggerSource = 'manual' }) {
    const existing = await pool.query(
        `SELECT *
         FROM instantly_sync_runs
         WHERE agency_id = $1
         AND client_id = $2
         AND status IN ('queued', 'running')
         ORDER BY started_at DESC
         LIMIT 1`,
        [agencyId, clientId]
    );

    if (existing.rows[0]) {
        return {
            run: normalizeSyncRunRow(existing.rows[0]),
            alreadyRunning: true
        };
    }

    const result = await pool.query(
        `INSERT INTO instantly_sync_runs (
            agency_id, client_id, trigger_source, status, progress_message
         )
         VALUES ($1, $2, $3, 'queued', 'Queued')
         RETURNING *`,
        [agencyId, clientId, triggerSource]
    );

    return {
        run: normalizeSyncRunRow(result.rows[0]),
        alreadyRunning: false
    };
}

async function updateInstantlySyncRun(runId, patch = {}) {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!entries.length) return null;

    const normalizedEntries = entries.map(([key, value]) => {
        if (key === 'metadata') return [key, JSON.stringify(value || {})];
        return [key, value];
    });

    const assignments = normalizedEntries.map(([column], index) => {
        if (column === 'metadata') return `${column} = $${index + 2}::jsonb`;
        return `${column} = $${index + 2}`;
    });

    const values = [runId, ...normalizedEntries.map(([, value]) => value)];
    const result = await pool.query(
        `UPDATE instantly_sync_runs
         SET ${assignments.join(', ')},
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        values
    );
    return normalizeSyncRunRow(result.rows[0] || null);
}

async function getInstantlySyncRunRowById(runId) {
    const result = await pool.query(
        `SELECT *
         FROM instantly_sync_runs
         WHERE id = $1
         LIMIT 1`,
        [runId]
    );
    return result.rows[0] || null;
}

const INSTANTLY_SYNC_STALE_MS = {
    queued: 15 * 60 * 1000,
    running: 45 * 60 * 1000,
    cancelling: 5 * 60 * 1000
};

async function reconcileStaleInstantlySyncRun(run) {
    if (!run) return null;
    const status = String(run.status || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(INSTANTLY_SYNC_STALE_MS, status)) {
        return run;
    }

    const updatedAtMs = new Date(run.updatedAt || run.startedAt || 0).getTime();
    if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0) return run;

    const staleAfterMs = INSTANTLY_SYNC_STALE_MS[status];
    if (Date.now() - updatedAtMs < staleAfterMs) {
        return run;
    }

    if (status === 'cancelling') {
        const metadata = mergeMetadataPatch(run.metadata, {
            cancelledAt: new Date().toISOString(),
            phase: 'cancelled',
            staleReconciledAt: new Date().toISOString()
        });
        return updateInstantlySyncRun(run.id, {
            status: 'cancelled',
            progress_message: 'Sync cancelled (stop request timed out)',
            completed_at: new Date().toISOString(),
            current_campaign_id: null,
            current_campaign_name: null,
            metadata
        });
    }

    return updateInstantlySyncRun(run.id, {
        status: 'failed',
        progress_message: status === 'queued' ? 'Sync never started (timed out)' : 'Sync timed out (no progress)',
        error: 'Sync run stopped responding and was marked failed.',
        completed_at: new Date().toISOString(),
        phase: 'failed',
        metadata: mergeMetadataPatch(run.metadata, {
            staleReconciledAt: new Date().toISOString()
        })
    });
}

export async function getInstantlySyncRun({ agencyId, clientSlug, runId }) {
    const clientId = await getOrCreateClient(agencyId, clientSlug);
    const result = await pool.query(
        `SELECT *
         FROM instantly_sync_runs
         WHERE id = $1
         AND agency_id = $2
         AND client_id = $3
         LIMIT 1`,
        [runId, agencyId, clientId]
    );
    const run = normalizeSyncRunRow(result.rows[0] || null);
    return reconcileStaleInstantlySyncRun(run);
}

export async function getLatestInstantlySyncRun({ agencyId, clientSlug }) {
    const clientId = await getOrCreateClient(agencyId, clientSlug);
    const result = await pool.query(
        `SELECT *
         FROM instantly_sync_runs
         WHERE agency_id = $1
         AND client_id = $2
         ORDER BY started_at DESC
         LIMIT 1`,
        [agencyId, clientId]
    );
    const run = normalizeSyncRunRow(result.rows[0] || null);
    return reconcileStaleInstantlySyncRun(run);
}

export function isAutomaticInstantlySyncEnabled() {
    return String(process.env.INSTANTLY_SYNC_AUTOMATIC_ENABLED || 'false').toLowerCase() === 'true';
}

/**
 * Cancel every queued/running/cancelling sync run (DB + in-process abort for this Node process).
 */
export async function stopAllActiveInstantlySyncRuns({ reason = 'Sync stopped' } = {}) {
    const result = await pool.query(
        `SELECT id, metadata
         FROM instantly_sync_runs
         WHERE status IN ('queued', 'running', 'cancelling')
         ORDER BY id ASC`
    );

    const stopped = [];
    for (const row of result.rows) {
        const runId = Number(row.id);
        abortInstantlyRequestsForRun(runId);
        const metadata = mergeMetadataPatch(row.metadata, {
            stopRequestedAt: new Date().toISOString(),
            cancelledAt: new Date().toISOString(),
            cancelReason: reason
        });
        const updated = await updateInstantlySyncRun(runId, {
            status: 'cancelled',
            progress_message: reason,
            completed_at: new Date().toISOString(),
            current_campaign_id: null,
            current_campaign_name: null,
            metadata
        });
        if (updated) stopped.push(updated);
    }

    return stopped;
}

export async function requestStopInstantlySyncRun({ agencyId, clientSlug, runId }) {
    const clientId = await getOrCreateClient(agencyId, clientSlug);
    const current = await pool.query(
        `SELECT *
         FROM instantly_sync_runs
         WHERE id = $1
         AND agency_id = $2
         AND client_id = $3
         LIMIT 1`,
        [runId, agencyId, clientId]
    );
    const row = current.rows[0];
    if (!row) {
        const error = new Error('Sync run not found.');
        error.statusCode = 404;
        throw error;
    }

    const normalized = normalizeSyncRunRow(row);
    if (!['queued', 'running', 'cancelling'].includes(normalized.status)) {
        return normalized;
    }

    const metadata = mergeMetadataPatch(row.metadata, {
        stopRequestedAt: new Date().toISOString()
    });

    const updatedRun = await updateInstantlySyncRun(runId, {
        status: 'cancelling',
        progress_message: 'Stop requested',
        metadata
    });
    abortInstantlyRequestsForRun(runId);
    return updatedRun;
}

async function shouldStopInstantlySyncRun(syncRunId) {
    if (!syncRunId) return false;
    const row = await getInstantlySyncRunRowById(syncRunId);
    if (!row) return false;

    const status = String(row.status || '').toLowerCase();
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    return status === 'cancelling' || Boolean(metadata.stopRequestedAt);
}

async function assertSyncRunNotCancelled(syncRunId) {
    if (!syncRunId) return;
    const stopRequested = await shouldStopInstantlySyncRun(syncRunId);
    if (stopRequested) {
        throw new InstantlySyncCancelledError();
    }
}

export async function beginInstantlySyncRun({
    agencyId,
    clientSlug,
    instantlyKey,
    triggerSource = 'manual',
    instantlyCampaignId = null,
    logger = () => {}
}) {
    const clientState = await resolveClientState(agencyId, clientSlug);
    if (!clientState) {
        throw new Error('Client not found in SQL.');
    }

    const created = await createInstantlySyncRun({
        agencyId,
        clientId: clientState.id,
        triggerSource
    });

    if (!created.alreadyRunning) {
        void syncClientInstantlyState({
            agencyId,
            clientSlug,
            instantlyKey,
            instantlyCampaignId,
            syncRunId: created.run.id,
            logger
        }).catch((error) => {
            logger(`Sync run ${created.run.id} failed: ${error?.message || error}`);
        });
    }

    return created;
}

export async function runInstantlySyncJob({ agencyId, clientSlug, instantlyKey, triggerSource = 'scheduled', logger = () => {} }) {
    if (triggerSource === 'scheduled' && !isAutomaticInstantlySyncEnabled()) {
        logger('Scheduled Instantly sync skipped (INSTANTLY_SYNC_AUTOMATIC_ENABLED is not true).');
        return { run: null, alreadyRunning: false, summary: null, skipped: true };
    }

    const clientState = await resolveClientState(agencyId, clientSlug);
    if (!clientState) {
        throw new Error('Client not found in SQL.');
    }

    const created = await createInstantlySyncRun({
        agencyId,
        clientId: clientState.id,
        triggerSource
    });

    if (created.alreadyRunning) {
        return {
            run: created.run,
            alreadyRunning: true,
            summary: null
        };
    }

    const summary = await syncClientInstantlyState({
        agencyId,
        clientSlug,
        instantlyKey,
        syncRunId: created.run.id,
        logger
    });

    return {
        run: await getInstantlySyncRun({ agencyId, clientSlug, runId: created.run.id }),
        alreadyRunning: false,
        summary
    };
}

async function updateClientState(clientId, patch = {}) {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!entries.length) return null;

    const assignments = entries.map(([column], index) => `${column} = $${index + 2}`);
    const values = [clientId, ...entries.map(([, value]) => value)];
    const result = await pool.query(
        `UPDATE clients
         SET ${assignments.join(', ')}
         WHERE id = $1
         RETURNING id, instantly_workspace_id, instantly_webhook_id, instantly_webhook_url,
                   instantly_webhook_status, instantly_last_synced_at, instantly_last_sync_error`,
        values
    );
    return result.rows[0] || null;
}

async function upsertCampaign(db, { agencyId, clientId, instantlyCampaignId, name, status = null, startDate = null, rawCampaignPayload = {}, lastSyncedAt = null }) {
    const result = await db.query(
        `INSERT INTO instantly_campaigns
            (agency_id, client_id, instantly_campaign_id, name, start_date, status, raw_campaign_payload, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (agency_id, client_id, instantly_campaign_id)
         DO UPDATE SET
            name = EXCLUDED.name,
            start_date = COALESCE(EXCLUDED.start_date, instantly_campaigns.start_date),
            status = COALESCE(EXCLUDED.status, instantly_campaigns.status),
            raw_campaign_payload = EXCLUDED.raw_campaign_payload,
            last_synced_at = COALESCE(EXCLUDED.last_synced_at, instantly_campaigns.last_synced_at)
         RETURNING id`,
        [
            agencyId,
            clientId,
            instantlyCampaignId,
            name,
            startDate,
            status,
            JSON.stringify(rawCampaignPayload || {}),
            lastSyncedAt
        ]
    );
    return Number(result.rows[0]?.id || 0) || null;
}

async function loadContactMapForEmails(db, clientId, emails) {
    const normalizedEmails = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
    if (!normalizedEmails.length) return new Map();
    const result = await db.query(
        `SELECT id, LOWER(email) AS email
         FROM contacts
         WHERE client_id = $1
         AND LOWER(email) = ANY($2::text[])`,
        [clientId, normalizedEmails]
    );
    return new Map(result.rows.map((row) => [row.email, Number(row.id)]));
}

async function ensureInstantlyCompany(db, { agencyId, clientId, domainNormalized }) {
    const result = await db.query(
        `INSERT INTO companies (agency_id, client_id, domain_normalized)
         VALUES ($1, $2, $3)
         ON CONFLICT (client_id, domain_normalized)
         DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [agencyId, clientId, domainNormalized]
    );
    return Number(result.rows[0]?.id || 0) || null;
}

async function upsertInstantlyContactInsights(db, {
    agencyId,
    clientId,
    contactId,
    source,
    campaign,
    lead
}) {
    if (!contactId) return;

    const customLeadProperties = extractLeadCustomProperties(lead);

    const attributes = {
        instantlyLeadId: asNullableText(lead?.id),
        instantlyCampaignId: asNullableText(campaign?.instantlyCampaignId),
        instantlyCampaignName: asNullableText(campaign?.campaignName),
        firstName: extractLeadFirstName(lead),
        lastName: extractLeadLastName(lead),
        fullName: extractLeadFullName(lead),
        email: normalizeEmail(lead?.email),
        domain: extractLeadDomain(lead),
        companyName: asNullableText(lead?.company_name || lead?.companyName || lead?.company),
        source,
        ...customLeadProperties
    };

    const sourcePayload = {
        campaign: {
            instantlyCampaignId: asNullableText(campaign?.instantlyCampaignId),
            campaignName: asNullableText(campaign?.campaignName)
        },
        lead: lead && typeof lead === 'object' ? lead : {}
    };

    await db.query(
        `INSERT INTO contact_insights (
            contact_id,
            agency_id,
            client_id,
            source,
            attributes,
            source_payload
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
        ON CONFLICT (contact_id)
        DO UPDATE SET
            client_id = COALESCE(EXCLUDED.client_id, contact_insights.client_id),
            source = COALESCE(EXCLUDED.source, contact_insights.source),
            attributes = COALESCE(contact_insights.attributes, '{}'::jsonb) || EXCLUDED.attributes,
            source_payload = CASE
                WHEN EXCLUDED.source_payload = '{}'::jsonb THEN contact_insights.source_payload
                ELSE EXCLUDED.source_payload
            END,
            updated_at = NOW()`,
        [
            contactId,
            agencyId,
            clientId,
            source,
            JSON.stringify(attributes),
            JSON.stringify(sourcePayload)
        ]
    );
}

async function ensureInstantlyContact(db, {
    agencyId,
    clientId,
    campaign,
    lead,
    source
}) {
    const normalizedEmail = normalizeEmail(lead?.email);
    if (!normalizedEmail) return null;

    const existingResult = await db.query(
        `SELECT id
         FROM contacts
         WHERE client_id = $1
         AND LOWER(email) = $2
         LIMIT 1`,
        [clientId, normalizedEmail]
    );

    let contactId = Number(existingResult.rows[0]?.id || 0) || null;

    if (!contactId) {
        const domainNormalized = extractLeadDomain(lead) || buildSyntheticInstantlyDomain(lead);
        const companyId = await ensureInstantlyCompany(db, {
            agencyId,
            clientId,
            domainNormalized
        });

        const fullName = extractLeadFullName(lead);
        const roleType = buildInstantlyRoleType(lead);

        try {
            const insertResult = await db.query(
                `INSERT INTO contacts (
                    agency_id,
                    client_id,
                    company_id,
                    role_type,
                    full_name,
                    email,
                    email_status,
                    confidence
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id`,
                [
                    agencyId,
                    clientId,
                    companyId,
                    roleType,
                    fullName,
                    normalizedEmail,
                    null,
                    null
                ]
            );
            contactId = Number(insertResult.rows[0]?.id || 0) || null;
        } catch (error) {
            if (error?.code !== '23505') throw error;
            const retryResult = await db.query(
                `SELECT id
                 FROM contacts
                 WHERE client_id = $1
                 AND LOWER(email) = $2
                 LIMIT 1`,
                [clientId, normalizedEmail]
            );
            contactId = Number(retryResult.rows[0]?.id || 0) || null;
        }
    } else {
        await db.query(
            `UPDATE contacts
             SET full_name = COALESCE(full_name, $2),
                 updated_at = NOW()
             WHERE id = $1`,
            [contactId, extractLeadFullName(lead)]
        );
    }

    if (contactId) {
        await upsertInstantlyContactInsights(db, {
            agencyId,
            clientId,
            contactId,
            source,
            campaign,
            lead
        });
    }

    return contactId;
}

const CAMPAIGN_SNAPSHOT_RECORDSET = `contact_id BIGINT,
                campaign_id BIGINT,
                upload_source TEXT,
                instantly_lead_id TEXT,
                added_at TIMESTAMPTZ,
                active BOOLEAN,
                last_seen_at TIMESTAMPTZ,
                lead_status INTEGER,
                lead_status_label TEXT,
                interest_status INTEGER,
                interest_status_label TEXT,
                verification_status INTEGER,
                email_open_count INTEGER,
                email_reply_count INTEGER,
                email_click_count INTEGER,
                timestamp_last_contact TIMESTAMPTZ,
                timestamp_last_open TIMESTAMPTZ,
                timestamp_last_reply TIMESTAMPTZ,
                timestamp_last_interest_change TIMESTAMPTZ,
                timestamp_last_click TIMESTAMPTZ,
                last_contacted_from TEXT,
                last_step_from TEXT,
                last_step_id TEXT,
                last_step_timestamp_executed TIMESTAMPTZ,
                status_summary JSONB,
                status_summary_subseq JSONB,
                raw_lead_payload JSONB,
                last_reply_category TEXT,
                last_event_type TEXT,
                last_bounce_at TIMESTAMPTZ,
                last_unsubscribe_at TIMESTAMPTZ,
                last_synced_at TIMESTAMPTZ`;

const CAMPAIGN_SNAPSHOT_UPSERT_SET = `
            upload_source = EXCLUDED.upload_source,
            instantly_lead_id = COALESCE(EXCLUDED.instantly_lead_id, contact_instantly_campaigns.instantly_lead_id),
            added_at = COALESCE(EXCLUDED.added_at, contact_instantly_campaigns.added_at),
            active = TRUE,
            last_seen_at = EXCLUDED.last_seen_at,
            removed_at = NULL,
            lead_status = COALESCE(EXCLUDED.lead_status, contact_instantly_campaigns.lead_status),
            lead_status_label = COALESCE(EXCLUDED.lead_status_label, contact_instantly_campaigns.lead_status_label),
            interest_status = COALESCE(EXCLUDED.interest_status, contact_instantly_campaigns.interest_status),
            interest_status_label = COALESCE(EXCLUDED.interest_status_label, contact_instantly_campaigns.interest_status_label),
            verification_status = COALESCE(EXCLUDED.verification_status, contact_instantly_campaigns.verification_status),
            email_open_count = GREATEST(contact_instantly_campaigns.email_open_count, EXCLUDED.email_open_count),
            email_reply_count = GREATEST(contact_instantly_campaigns.email_reply_count, EXCLUDED.email_reply_count),
            email_click_count = GREATEST(contact_instantly_campaigns.email_click_count, EXCLUDED.email_click_count),
            timestamp_last_contact = COALESCE(EXCLUDED.timestamp_last_contact, contact_instantly_campaigns.timestamp_last_contact),
            timestamp_last_open = COALESCE(EXCLUDED.timestamp_last_open, contact_instantly_campaigns.timestamp_last_open),
            timestamp_last_reply = COALESCE(EXCLUDED.timestamp_last_reply, contact_instantly_campaigns.timestamp_last_reply),
            timestamp_last_interest_change = COALESCE(EXCLUDED.timestamp_last_interest_change, contact_instantly_campaigns.timestamp_last_interest_change),
            timestamp_last_click = COALESCE(EXCLUDED.timestamp_last_click, contact_instantly_campaigns.timestamp_last_click),
            last_contacted_from = COALESCE(EXCLUDED.last_contacted_from, contact_instantly_campaigns.last_contacted_from),
            last_step_from = COALESCE(EXCLUDED.last_step_from, contact_instantly_campaigns.last_step_from),
            last_step_id = COALESCE(EXCLUDED.last_step_id, contact_instantly_campaigns.last_step_id),
            last_step_timestamp_executed = COALESCE(EXCLUDED.last_step_timestamp_executed, contact_instantly_campaigns.last_step_timestamp_executed),
            status_summary = CASE
                WHEN EXCLUDED.status_summary = '{}'::jsonb THEN contact_instantly_campaigns.status_summary
                ELSE EXCLUDED.status_summary
            END,
            status_summary_subseq = CASE
                WHEN EXCLUDED.status_summary_subseq = '{}'::jsonb THEN contact_instantly_campaigns.status_summary_subseq
                ELSE EXCLUDED.status_summary_subseq
            END,
            raw_lead_payload = CASE
                WHEN EXCLUDED.raw_lead_payload = '{}'::jsonb THEN contact_instantly_campaigns.raw_lead_payload
                ELSE EXCLUDED.raw_lead_payload
            END,
            last_reply_category = COALESCE(EXCLUDED.last_reply_category, contact_instantly_campaigns.last_reply_category),
            last_event_type = COALESCE(EXCLUDED.last_event_type, contact_instantly_campaigns.last_event_type),
            last_bounce_at = COALESCE(EXCLUDED.last_bounce_at, contact_instantly_campaigns.last_bounce_at),
            last_unsubscribe_at = COALESCE(EXCLUDED.last_unsubscribe_at, contact_instantly_campaigns.last_unsubscribe_at),
            last_synced_at = COALESCE(EXCLUDED.last_synced_at, contact_instantly_campaigns.last_synced_at)`;

/** One row per Instantly lead and per (contact_id, campaign_id) in a batch. */
function dedupeCampaignSnapshotRows(rows) {
    const byLead = new Map();
    const withoutLead = [];
    for (const row of rows) {
        const leadId = asNullableText(row.instantly_lead_id);
        if (leadId) {
            byLead.set(`${row.campaign_id}::${leadId}`, row);
        } else {
            withoutLead.push(row);
        }
    }
    const merged = [...byLead.values(), ...withoutLead];
    const byContactCampaign = new Map();
    for (const row of merged) {
        byContactCampaign.set(`${row.contact_id}::${row.campaign_id}`, row);
    }
    return [...byContactCampaign.values()];
}

/** Drop prior contact row for this Instantly lead before inserting the resolved contact (avoids PK + lead unique clashes). */
async function deleteCampaignMembershipsByInstantlyLead(db, rows) {
    const payload = rows
        .map((row) => ({
            campaign_id: row.campaign_id,
            instantly_lead_id: asNullableText(row.instantly_lead_id)
        }))
        .filter((row) => row.instantly_lead_id);
    if (!payload.length) return;

    await db.query(
        `WITH input AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS x(
                campaign_id BIGINT,
                instantly_lead_id TEXT
            )
        )
        DELETE FROM contact_instantly_campaigns cic
        USING input i
        WHERE cic.campaign_id = i.campaign_id
          AND cic.instantly_lead_id = i.instantly_lead_id`,
        [JSON.stringify(payload)]
    );
}

async function upsertCampaignSnapshotBatch(db, rows, onConflictClause) {
    if (!rows.length) return;
    await db.query(
        `WITH input AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS x(${CAMPAIGN_SNAPSHOT_RECORDSET})
        )
        INSERT INTO contact_instantly_campaigns (
            contact_id, campaign_id, upload_source, instantly_lead_id, added_at, active, last_seen_at, removed_at,
            lead_status, lead_status_label, interest_status, interest_status_label, verification_status,
            email_open_count, email_reply_count, email_click_count,
            timestamp_last_contact, timestamp_last_open, timestamp_last_reply, timestamp_last_interest_change, timestamp_last_click,
            last_contacted_from, last_step_from, last_step_id, last_step_timestamp_executed,
            status_summary, status_summary_subseq, raw_lead_payload,
            last_reply_category, last_event_type, last_bounce_at, last_unsubscribe_at, last_synced_at
        )
        SELECT
            contact_id, campaign_id, upload_source, instantly_lead_id, added_at, active, last_seen_at, NULL,
            lead_status, lead_status_label, interest_status, interest_status_label, verification_status,
            email_open_count, email_reply_count, email_click_count,
            timestamp_last_contact, timestamp_last_open, timestamp_last_reply, timestamp_last_interest_change, timestamp_last_click,
            last_contacted_from, last_step_from, last_step_id, last_step_timestamp_executed,
            status_summary, status_summary_subseq, raw_lead_payload,
            last_reply_category, last_event_type, last_bounce_at, last_unsubscribe_at, last_synced_at
        FROM input
        ${onConflictClause}`,
        [JSON.stringify(rows)]
    );
}

async function upsertCampaignSnapshots(db, rows) {
    if (!rows.length) return;
    const deduped = dedupeCampaignSnapshotRows(rows);
    const withLead = deduped.filter((row) => asNullableText(row.instantly_lead_id));

    if (withLead.length) {
        await deleteCampaignMembershipsByInstantlyLead(db, withLead);
    }

    await upsertCampaignSnapshotBatch(
        db,
        deduped,
        `ON CONFLICT (contact_id, campaign_id)
        DO UPDATE SET ${CAMPAIGN_SNAPSHOT_UPSERT_SET}`
    );
}

async function updateContactLastContacted(db, rows) {
    const contactRows = rows
        .filter((row) => row.contact_id && row.timestamp_last_contact)
        .map((row) => ({
            contact_id: row.contact_id,
            timestamp_last_contact: row.timestamp_last_contact
        }));
    if (!contactRows.length) return;

    await db.query(
        `WITH input AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS x(
                contact_id BIGINT,
                timestamp_last_contact TIMESTAMPTZ
            )
        )
        UPDATE contacts AS c
        SET last_contacted_at = input.timestamp_last_contact,
            updated_at = NOW()
        FROM input
        WHERE c.id = input.contact_id
        AND input.timestamp_last_contact IS NOT NULL
        AND (c.last_contacted_at IS NULL OR c.last_contacted_at < input.timestamp_last_contact)`,
        [JSON.stringify(contactRows)]
    );
}

const INTEREST_STATUS_TO_EVENT_TYPE = new Map([
    [4, 'lead_closed'],
    [3, 'lead_meeting_completed'],
    [2, 'lead_meeting_booked'],
    [1, 'lead_interested'],
    [0, 'lead_out_of_office'],
    [-1, 'lead_not_interested'],
    [-2, 'lead_wrong_person'],
    [-4, 'lead_no_show']
]);

export function mapInterestStatusToEventType(interestStatus) {
    const numericStatus = asNullableInt(interestStatus);
    if (numericStatus === null) return null;
    return INTEREST_STATUS_TO_EVENT_TYPE.get(numericStatus) || null;
}

function buildInterestReconcileFingerprint({
    source,
    contactId,
    campaignId,
    previousInterestStatus,
    nextInterestStatus,
    eventTimestamp
}) {
    const base = [
        source,
        String(contactId),
        String(campaignId),
        String(previousInterestStatus ?? ''),
        String(nextInterestStatus ?? ''),
        asNullableTimestamp(eventTimestamp) || ''
    ].join('|');
    return crypto.createHash('sha256').update(base).digest('hex');
}

export function computeInterestStatusChanges(priorByKey, snapshots) {
    const changes = [];
    for (const row of snapshots) {
        const contactId = Number(row.contact_id || 0) || null;
        const campaignId = Number(row.campaign_id || 0) || null;
        if (!contactId || !campaignId) continue;

        const key = `${contactId}::${campaignId}`;
        const prior = priorByKey.get(key) || {};
        const previousInterestStatus = asNullableInt(prior.interest_status);
        const nextInterestStatus = asNullableInt(row.interest_status);
        if (previousInterestStatus === nextInterestStatus) continue;

        changes.push({
            contact_id: contactId,
            campaign_id: campaignId,
            instantly_lead_id: asNullableText(row.instantly_lead_id),
            previous_interest_status: previousInterestStatus,
            next_interest_status: nextInterestStatus,
            timestamp_last_interest_change: asNullableTimestamp(row.timestamp_last_interest_change)
        });
    }
    return changes;
}

async function loadCampaignInterestStateMap(db, snapshots) {
    const pairs = dedupeCampaignSnapshotRows(snapshots)
        .map((row) => ({
            contact_id: Number(row.contact_id || 0) || null,
            campaign_id: Number(row.campaign_id || 0) || null
        }))
        .filter((row) => row.contact_id && row.campaign_id);
    if (!pairs.length) return new Map();

    const result = await db.query(
        `WITH input AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS x(
                contact_id BIGINT,
                campaign_id BIGINT
            )
        )
        SELECT cic.contact_id, cic.campaign_id, cic.interest_status, cic.timestamp_last_interest_change
        FROM contact_instantly_campaigns cic
        INNER JOIN input i
            ON cic.contact_id = i.contact_id
           AND cic.campaign_id = i.campaign_id`,
        [JSON.stringify(pairs)]
    );

    const priorByKey = new Map();
    for (const row of result.rows) {
        priorByKey.set(`${row.contact_id}::${row.campaign_id}`, row);
    }
    return priorByKey;
}

async function loadContactEmailsById(db, contactIds) {
    const ids = [...new Set(contactIds.filter((id) => Number(id) > 0))];
    if (!ids.length) return new Map();

    const result = await db.query(
        `SELECT id, email
         FROM contacts
         WHERE id = ANY($1::bigint[])`,
        [ids]
    );
    return new Map(result.rows.map((row) => [Number(row.id), asNullableText(row.email)]));
}

async function hasRecentInterestedWebhookEvent(db, { contactId, campaignId, eventTimestamp }) {
    const result = await db.query(
        `SELECT 1
         FROM contact_instantly_events
         WHERE contact_id = $1
           AND campaign_id = $2
           AND LOWER(event_type) = 'lead_interested'
           AND source = 'webhook'
           AND event_timestamp >= COALESCE($3::timestamptz, NOW()) - INTERVAL '24 hours'
         LIMIT 1`,
        [contactId, campaignId, eventTimestamp]
    );
    return result.rowCount > 0;
}

async function hasRecentInterestStatusWebhookNearReply(db, {
    contactId,
    campaignId,
    replyEventTimestamp,
    windowMs = INSTANTLY_REPLY_INTEREST_RECONCILE_WINDOW_MS
}) {
    const anchor = asNullableTimestamp(replyEventTimestamp);
    if (!anchor) return false;

    const windowSeconds = Math.max(windowMs, 0) / 1000;
    const result = await db.query(
        `SELECT 1
         FROM contact_instantly_events
         WHERE contact_id = $1
           AND campaign_id = $2
           AND source = 'webhook'
           AND LOWER(event_type) = ANY($3::text[])
           AND event_timestamp >= $4::timestamptz - ($5::double precision * INTERVAL '1 second')
           AND event_timestamp <= $4::timestamptz + ($5::double precision * INTERVAL '1 second')
         LIMIT 1`,
        [contactId, campaignId, INSTANTLY_INTEREST_STATUS_WEBHOOK_EVENT_TYPES, anchor, windowSeconds]
    );
    return result.rowCount > 0;
}

async function loadContactCampaignInterestState(db, contactId, campaignId) {
    const result = await db.query(
        `SELECT interest_status, instantly_lead_id, timestamp_last_interest_change
         FROM contact_instantly_campaigns
         WHERE contact_id = $1
           AND campaign_id = $2
         LIMIT 1`,
        [contactId, campaignId]
    );
    return result.rows[0] || null;
}

async function hasOpenInterestedAutoresponderDraft(db, contactId, campaignId) {
    const result = await db.query(
        `SELECT 1
         FROM interested_autoresponder_drafts
         WHERE contact_id = $1
           AND campaign_id = $2
           AND status = ANY($3::text[])
         LIMIT 1`,
        [contactId, campaignId, ['pending_review', 'blocked_missing_thread']]
    );
    return result.rowCount > 0;
}

async function applyInterestEventPatchToCampaign(db, {
    contactId,
    campaignId,
    instantlyLeadId,
    eventPatch
}) {
    await db.query(
        `UPDATE contact_instantly_campaigns
         SET instantly_lead_id = COALESCE($3, instantly_lead_id),
             interest_status = COALESCE($4, interest_status),
             interest_status_label = COALESCE($5, interest_status_label),
             timestamp_last_interest_change = COALESCE($6, timestamp_last_interest_change),
             timestamp_last_reply = COALESCE($7, timestamp_last_reply),
             last_reply_category = COALESCE($8, last_reply_category),
             last_event_type = COALESCE($9, last_event_type),
             last_synced_at = NOW()
         WHERE contact_id = $1
           AND campaign_id = $2`,
        [
            contactId,
            campaignId,
            instantlyLeadId,
            eventPatch.interestStatus,
            eventPatch.interestStatusLabel,
            eventPatch.timestampLastInterestChange,
            eventPatch.timestampLastReply,
            eventPatch.lastReplyCategory,
            eventPatch.lastEventType
        ]
    );
}

async function insertReconcileInterestEvent(db, {
    agencyId,
    clientId,
    contactId,
    campaignId,
    instantlyCampaignId,
    instantlyLeadId,
    leadEmail,
    eventType,
    eventTimestamp,
    previousInterestStatus,
    nextInterestStatus,
    reconcileSource,
    reconcileContext = {}
}) {
    const syntheticEvent = {
        event_type: eventType,
        timestamp: eventTimestamp,
        campaign_id: instantlyCampaignId,
        lead_id: instantlyLeadId,
        lead_email: leadEmail,
        previous_interest_status: previousInterestStatus,
        next_interest_status: nextInterestStatus,
        source: reconcileSource,
        ...reconcileContext
    };
    const fingerprint = buildInterestReconcileFingerprint({
        source: reconcileSource,
        contactId,
        campaignId,
        previousInterestStatus,
        nextInterestStatus,
        eventTimestamp
    });
    const eventPatch = buildEventPatch(syntheticEvent, eventTimestamp);
    const insertResult = await db.query(
        `INSERT INTO contact_instantly_events (
            agency_id, client_id, contact_id, campaign_id, instantly_campaign_id, instantly_lead_id,
            event_type, reply_category, lead_email, event_timestamp, fingerprint, source, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
        ON CONFLICT (source, fingerprint) DO NOTHING
        RETURNING id`,
        [
            agencyId,
            clientId,
            contactId,
            campaignId,
            instantlyCampaignId,
            instantlyLeadId,
            eventType,
            eventPatch.lastReplyCategory,
            leadEmail,
            eventTimestamp,
            fingerprint,
            reconcileSource,
            JSON.stringify(syntheticEvent)
        ]
    );
    return {
        eventId: insertResult.rows[0]?.id || null,
        eventPatch,
        deduplicated: !insertResult.rowCount
    };
}

async function applySyncInterestReconciliation(db, {
    agencyId,
    clientId,
    instantlyCampaignId,
    interestChanges,
    syncStartedAt,
    logger = () => {}
}) {
    const autoresponderTriggers = [];
    if (!interestChanges.length) {
        return { autoresponderTriggers, syntheticEventsInserted: 0 };
    }

    const emailByContactId = await loadContactEmailsById(
        db,
        interestChanges.map((change) => change.contact_id)
    );
    let syntheticEventsInserted = 0;

    for (const change of interestChanges) {
        const eventType = mapInterestStatusToEventType(change.next_interest_status);
        if (!eventType) continue;

        const eventTimestamp = change.timestamp_last_interest_change || syncStartedAt;
        const leadEmail = normalizeEmail(emailByContactId.get(change.contact_id));
        const { eventId, eventPatch, deduplicated } = await insertReconcileInterestEvent(db, {
            agencyId,
            clientId,
            contactId: change.contact_id,
            campaignId: change.campaign_id,
            instantlyCampaignId,
            instantlyLeadId: change.instantly_lead_id,
            leadEmail,
            eventType,
            eventTimestamp,
            previousInterestStatus: change.previous_interest_status,
            nextInterestStatus: change.next_interest_status,
            reconcileSource: 'sync_reconcile',
            reconcileContext: { synced_at: syncStartedAt }
        });

        if (deduplicated || !eventId) continue;
        syntheticEventsInserted += 1;

        await applyInterestEventPatchToCampaign(db, {
            contactId: change.contact_id,
            campaignId: change.campaign_id,
            instantlyLeadId: change.instantly_lead_id,
            eventPatch
        });

        if (change.next_interest_status !== 1) {
            await cancelNonInterestedAutoResponderDrafts(db, change.contact_id, change.campaign_id);
            continue;
        }

        if (change.previous_interest_status === 1) continue;

        const skipWebhook = await hasRecentInterestedWebhookEvent(db, {
            contactId: change.contact_id,
            campaignId: change.campaign_id,
            eventTimestamp
        });
        const skipOpenDraft = await hasOpenInterestedAutoresponderDraft(db, change.contact_id, change.campaign_id);
        if (skipWebhook || skipOpenDraft) {
            logger(
                `[instantly-sync] skipped autoresponder for contact=${change.contact_id} campaign=${change.campaign_id}`
                + ` (webhook=${skipWebhook}, openDraft=${skipOpenDraft})`
            );
            continue;
        }

        autoresponderTriggers.push({
            campaignId: change.campaign_id,
            contactId: change.contact_id,
            instantlyLeadId: change.instantly_lead_id,
            sourceEventId: eventId,
            leadEmail
        });
        logger(
            `[instantly-sync] queued autoresponder from sync reconcile contact=${change.contact_id}`
            + ` campaign=${change.campaign_id} event=${eventId}`
        );
    }

    return { autoresponderTriggers, syntheticEventsInserted };
}

async function processSyncAutoresponderTriggers({
    agencyId,
    clientSlug,
    clientId,
    triggers,
    logger = () => {}
}) {
    for (const trigger of triggers) {
        try {
            await createInterestedAutoResponderDraftFromEvent({
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
        } catch (error) {
            logger(
                `[instantly-sync] autoresponder failed contact=${trigger.contactId}`
                + ` campaign=${trigger.campaignId}: ${error.message}`
            );
        }
    }
}

export function buildInstantlyWebhookTargetUrl(req, agencyId, clientSlug) {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').toString();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
    if (!host) return null;
    return `${proto}://${host}/webhook/instantly/events/${agencyId}/${clientSlug}`;
}

export function generateInstantlyWebhookSecret() {
    return crypto.randomBytes(24).toString('hex');
}

export async function registerInstantlyWebhook({ agencyId, clientSlug, instantlyKey, targetUrl, rotateSecret = false }) {
    const clientState = await resolveClientState(agencyId, clientSlug);
    if (!clientState) {
        throw new Error('Client not found in SQL.');
    }

    const secret = rotateSecret || !clientState.instantly_webhook_secret
        ? generateInstantlyWebhookSecret()
        : clientState.instantly_webhook_secret;

    const webhookPayload = {
        name: `Shields Outbound ${clientSlug} lead sync`,
        target_hook_url: targetUrl,
        event_type: 'all_events',
        headers: {
            'x-shields-webhook-secret': secret
        }
    };

    let response;
    if (clientState.instantly_webhook_id) {
        try {
            response = await instantlyRequest({
                apiKey: instantlyKey,
                path: `/api/v2/webhooks/${clientState.instantly_webhook_id}`,
                method: 'PATCH',
                body: webhookPayload
            });
        } catch {
            response = await instantlyRequest({
                apiKey: instantlyKey,
                path: '/api/v2/webhooks',
                method: 'POST',
                body: webhookPayload
            });
        }
    } else {
        response = await instantlyRequest({
            apiKey: instantlyKey,
            path: '/api/v2/webhooks',
            method: 'POST',
            body: webhookPayload
        });
    }

    await updateClientState(clientState.id, {
        instantly_workspace_id: asNullableText(response?.organization) || clientState.instantly_workspace_id,
        instantly_webhook_id: asNullableText(response?.id),
        instantly_webhook_secret: secret,
        instantly_webhook_url: asNullableText(response?.target_hook_url) || targetUrl,
        instantly_webhook_status: asNullableInt(response?.status),
        instantly_last_sync_error: null
    });

    return {
        clientId: clientState.id,
        secret,
        webhook: response
    };
}

export async function syncClientEmailAccounts({ agencyId, clientSlug, instantlyKey, logger = () => {} }) {
    const clientState = await resolveClientState(agencyId, clientSlug);
    if (!clientState) {
        throw new Error('Client not found in SQL.');
    }

    const accounts = await fetchInstantlyAccounts(instantlyKey);
    const syncedAt = new Date().toISOString();
    const normalizedRows = accounts
        .map((account) => {
            const email = normalizeEmail(account?.email);
            if (!email) return null;
            return {
                agency_id: agencyId,
                client_id: clientState.id,
                email,
                first_name: asNullableText(account?.first_name),
                last_name: asNullableText(account?.last_name),
                provider_code: asNullableInt(account?.provider_code),
                signature: asNullableText(account?.signature),
                instantly_workspace_id: asNullableText(account?.organization_id || account?.workspace_id || account?.organization),
                raw_payload: asJsonObject(account),
                last_synced_at: syncedAt
            };
        })
        .filter(Boolean);

    const syncedCount = await upsertEmailAccounts(pool, normalizedRows);
    logger(`Synced ${syncedCount} email account(s) for ${agencyId}/${clientSlug}`);

    return {
        clientId: clientState.id,
        syncedCount,
        syncedAt
    };
}

export async function syncClientInstantlyState({
    agencyId,
    clientSlug,
    instantlyKey,
    instantlyCampaignId = null,
    syncRunId = null,
    logger = () => {}
}) {
    const sqlClientId = await getOrCreateClient(agencyId, clientSlug);
    const syncStartedAt = new Date().toISOString();
    const customInterestLabels = new Map();
    try {
        const warmFollowUpConfigResult = await pool.query(
            `SELECT warm_follow_up_interest_value, warm_follow_up_interest_label
             FROM clients
             WHERE id = $1
             LIMIT 1`,
            [sqlClientId]
        );
        const warmFollowUpRow = warmFollowUpConfigResult.rows[0] || null;
        const warmFollowUpValue = asNullableInt(warmFollowUpRow?.warm_follow_up_interest_value);
        const warmFollowUpLabel = asNullableText(warmFollowUpRow?.warm_follow_up_interest_label);
        if (warmFollowUpValue !== null && warmFollowUpLabel) {
            customInterestLabels.set(warmFollowUpValue, warmFollowUpLabel);
        }
    } catch (error) {
        logger(`[instantly-sync] failed loading custom interest labels: ${error?.message || error}`);
    }

    try {
        if (syncRunId) {
            await publishInstantlySyncProgress(syncRunId, {
                status: 'running',
                progress_message: 'Fetching campaigns from Instantly',
                started_at: syncStartedAt,
                completed_at: null,
                error: null,
                total_campaigns: 0,
                campaigns_completed: 0,
                total_leads_seen: 0,
                matched_leads: 0,
                unmatched_leads: 0,
                current_campaign_id: null,
                current_campaign_name: null,
                phase: 'fetching_campaigns',
                currentCampaignFetchedLeads: 0,
                currentCampaignLeadTotal: null,
                currentCampaignProcessedLeads: 0,
                currentCampaignMatchedLeads: 0,
                currentCampaignUnmatchedLeads: 0
            });
        }

        const allCampaigns = await fetchInstantlyCampaigns(instantlyKey, { syncRunId });
        const targetCampaignId = asNullableText(instantlyCampaignId);
        const campaigns = filterCampaignsForSync(allCampaigns, targetCampaignId);
        logger(
            targetCampaignId
                ? `Fetched ${allCampaigns.length} Instantly campaign(s); syncing ${campaigns.length} matching ${targetCampaignId} for ${agencyId}/${clientSlug}`
                : `Fetched ${campaigns.length} Instantly campaigns for ${agencyId}/${clientSlug}`
        );

        if (targetCampaignId && !campaigns.length) {
            throw new Error(`Instantly campaign not found: ${targetCampaignId}`);
        }

        if (syncRunId) {
            await publishInstantlySyncProgress(syncRunId, {
                progress_message: campaigns.length
                    ? (targetCampaignId
                        ? `Syncing campaign ${targetCampaignId}`
                        : `Fetched ${campaigns.length} campaign(s) from Instantly`)
                    : 'No Instantly campaigns found',
                total_campaigns: campaigns.length,
                phase: 'processing_campaigns'
            });
        }

        let totalLeadsSeen = 0;
        let matchedLeads = 0;
        let unmatchedLeads = 0;
        let campaignsSynced = 0;
        const syncAutoresponderTriggers = [];

        for (const campaign of campaigns) {
            await assertSyncRunNotCancelled(syncRunId);
            const instantlyCampaignId = resolveInstantlyCampaignIdFromPayload(campaign);
            const campaignName = asNullableText(campaign?.name || campaign?.title || campaign?.campaign_name);
            if (!instantlyCampaignId || !campaignName) continue;

            if (syncRunId) {
                await publishInstantlySyncProgress(syncRunId, {
                    progress_message: `Fetching leads for ${campaignName}`,
                    current_campaign_id: instantlyCampaignId,
                    current_campaign_name: campaignName,
                    total_leads_seen: totalLeadsSeen,
                    matched_leads: matchedLeads,
                    unmatched_leads: unmatchedLeads,
                    campaigns_completed: campaignsSynced,
                    phase: 'fetching_campaign_leads',
                    currentCampaignFetchedLeads: 0,
                    currentCampaignLeadTotal: null,
                    currentCampaignProcessedLeads: 0,
                    currentCampaignMatchedLeads: 0,
                    currentCampaignUnmatchedLeads: 0
                });
            }

            const sqlCampaignId = await upsertCampaign(pool, {
                agencyId,
                clientId: sqlClientId,
                instantlyCampaignId,
                name: campaignName,
                status: asNullableInt(campaign?.status ?? campaign?.state),
                startDate: asNullableTimestamp(campaign?.timestamp_created || campaign?.createdAt || campaign?.created_at || campaign?.created || campaign?.created_at_utc),
                rawCampaignPayload: campaign,
                lastSyncedAt: syncStartedAt
            });

            const leads = await fetchCampaignLeads(instantlyKey, instantlyCampaignId, {
                syncRunId,
                logger: (message) => logger(message),
                onProgress: syncRunId
                    ? async ({ fetchedLeads }) => {
                        await publishInstantlySyncProgress(syncRunId, {
                            progress_message: `Fetched ${fetchedLeads} lead${fetchedLeads === 1 ? '' : 's'} from ${campaignName}`,
                            current_campaign_id: instantlyCampaignId,
                            current_campaign_name: campaignName,
                            total_leads_seen: totalLeadsSeen,
                            matched_leads: matchedLeads,
                            unmatched_leads: unmatchedLeads,
                            campaigns_completed: campaignsSynced,
                            phase: 'fetching_campaign_leads',
                            currentCampaignFetchedLeads: fetchedLeads,
                            currentCampaignLeadTotal: null,
                            currentCampaignProcessedLeads: 0,
                            currentCampaignMatchedLeads: 0,
                            currentCampaignUnmatchedLeads: 0
                        });
                    }
                    : null
            });
            totalLeadsSeen += leads.length;

            if (syncRunId) {
                await publishInstantlySyncProgress(syncRunId, {
                    progress_message: `Processing 0/${leads.length} leads in ${campaignName}`,
                    current_campaign_id: instantlyCampaignId,
                    current_campaign_name: campaignName,
                    total_leads_seen: totalLeadsSeen,
                    matched_leads: matchedLeads,
                    unmatched_leads: unmatchedLeads,
                    campaigns_completed: campaignsSynced,
                    phase: 'processing_campaign_leads',
                    currentCampaignFetchedLeads: leads.length,
                    currentCampaignLeadTotal: leads.length,
                    currentCampaignProcessedLeads: 0,
                    currentCampaignMatchedLeads: 0,
                    currentCampaignUnmatchedLeads: 0
                });
            }

            const contactMap = await loadContactMapForEmails(
                pool,
                sqlClientId,
                leads.map((lead) => lead?.email)
            );

            const matchedSnapshots = [];
            let matchedLeadsInCampaign = 0;
            let unmatchedLeadsInCampaign = 0;
            for (let leadIndex = 0; leadIndex < leads.length; leadIndex += 1) {
                if (leadIndex % 50 === 0) {
                    await assertSyncRunNotCancelled(syncRunId);
                }
                const lead = leads[leadIndex];
                const email = normalizeEmail(lead?.email);
                let contactId = email ? contactMap.get(email) : null;
                if (!contactId && email) {
                    contactId = await ensureInstantlyContact(pool, {
                        agencyId,
                        clientId: sqlClientId,
                        campaign: {
                            instantlyCampaignId,
                            campaignName
                        },
                        lead,
                        source: 'instantly_sync'
                    });
                    if (contactId) {
                        contactMap.set(email, contactId);
                    }
                }
                if (!contactId) {
                    unmatchedLeads += 1;
                    unmatchedLeadsInCampaign += 1;
                    if (
                        syncRunId
                        && (
                            ((leadIndex + 1) % INSTANTLY_SYNC_PROGRESS_BATCH_SIZE === 0)
                            || leadIndex === leads.length - 1
                        )
                    ) {
                        await publishInstantlySyncProgress(syncRunId, {
                            progress_message: `${leadIndex + 1}/${leads.length} leads processed in ${campaignName}`,
                            total_leads_seen: totalLeadsSeen,
                            matched_leads: matchedLeads,
                            unmatched_leads: unmatchedLeads,
                            campaigns_completed: campaignsSynced,
                            phase: 'processing_campaign_leads',
                            currentCampaignFetchedLeads: leads.length,
                            currentCampaignLeadTotal: leads.length,
                            currentCampaignProcessedLeads: leadIndex + 1,
                            currentCampaignMatchedLeads: matchedLeadsInCampaign,
                            currentCampaignUnmatchedLeads: unmatchedLeadsInCampaign
                        });
                    }
                    continue;
                }

                matchedLeads += 1;
                matchedLeadsInCampaign += 1;
                const snapshot = deriveSnapshotFromLead(lead, syncStartedAt, customInterestLabels);
                matchedSnapshots.push({
                    contact_id: contactId,
                    campaign_id: sqlCampaignId,
                    upload_source: 'instantly_sync',
                    instantly_lead_id: snapshot.instantlyLeadId,
                    added_at: snapshot.addedAt,
                    active: snapshot.active,
                    last_seen_at: snapshot.lastSeenAt,
                    lead_status: snapshot.leadStatus,
                    lead_status_label: snapshot.leadStatusLabel,
                    interest_status: snapshot.interestStatus,
                    interest_status_label: snapshot.interestStatusLabel,
                    verification_status: snapshot.verificationStatus,
                    email_open_count: snapshot.emailOpenCount,
                    email_reply_count: snapshot.emailReplyCount,
                    email_click_count: snapshot.emailClickCount,
                    timestamp_last_contact: snapshot.timestampLastContact,
                    timestamp_last_open: snapshot.timestampLastOpen,
                    timestamp_last_reply: snapshot.timestampLastReply,
                    timestamp_last_interest_change: snapshot.timestampLastInterestChange,
                    timestamp_last_click: snapshot.timestampLastClick,
                    last_contacted_from: snapshot.lastContactedFrom,
                    last_step_from: snapshot.lastStepFrom,
                    last_step_id: snapshot.lastStepId,
                    last_step_timestamp_executed: snapshot.lastStepTimestampExecuted,
                    status_summary: snapshot.statusSummary,
                    status_summary_subseq: snapshot.statusSummarySubseq,
                    raw_lead_payload: snapshot.rawLeadPayload,
                    last_reply_category: snapshot.lastReplyCategory,
                    last_event_type: snapshot.lastEventType,
                    last_bounce_at: snapshot.lastBounceAt,
                    last_unsubscribe_at: snapshot.lastUnsubscribeAt,
                    last_synced_at: snapshot.lastSyncedAt
                });

                if (
                    syncRunId
                    && (
                        ((leadIndex + 1) % INSTANTLY_SYNC_PROGRESS_BATCH_SIZE === 0)
                        || leadIndex === leads.length - 1
                    )
                ) {
                    await publishInstantlySyncProgress(syncRunId, {
                        progress_message: `${leadIndex + 1}/${leads.length} leads processed in ${campaignName}`,
                        total_leads_seen: totalLeadsSeen,
                        matched_leads: matchedLeads,
                        unmatched_leads: unmatchedLeads,
                        campaigns_completed: campaignsSynced,
                        phase: 'processing_campaign_leads',
                        currentCampaignFetchedLeads: leads.length,
                        currentCampaignLeadTotal: leads.length,
                        currentCampaignProcessedLeads: leadIndex + 1,
                        currentCampaignMatchedLeads: matchedLeadsInCampaign,
                        currentCampaignUnmatchedLeads: unmatchedLeadsInCampaign
                    });
                }
            }

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                if (matchedSnapshots.length > 0) {
                    const priorByKey = await loadCampaignInterestStateMap(client, matchedSnapshots);
                    await upsertCampaignSnapshots(client, matchedSnapshots);
                    await updateContactLastContacted(client, matchedSnapshots);

                    const interestChanges = computeInterestStatusChanges(priorByKey, matchedSnapshots);
                    if (interestChanges.length) {
                        const reconcileOutcome = await applySyncInterestReconciliation(client, {
                            agencyId,
                            clientId: sqlClientId,
                            instantlyCampaignId,
                            interestChanges,
                            syncStartedAt,
                            logger
                        });
                        syncAutoresponderTriggers.push(...reconcileOutcome.autoresponderTriggers);
                        if (reconcileOutcome.syntheticEventsInserted > 0) {
                            logger(
                                `Recorded ${reconcileOutcome.syntheticEventsInserted} synthetic interest event(s)`
                                + ` for ${campaignName}`
                            );
                        }
                    }
                }
                await client.query(
                    `UPDATE contact_instantly_campaigns
                     SET active = FALSE,
                         removed_at = COALESCE(removed_at, NOW()),
                         last_synced_at = $2
                     WHERE campaign_id = $1
                     AND active = TRUE
                     AND (last_seen_at IS NULL OR last_seen_at < $2::timestamptz)`,
                    [sqlCampaignId, syncStartedAt]
                );
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }

            campaignsSynced += 1;

            if (syncRunId) {
                await publishInstantlySyncProgress(syncRunId, {
                    progress_message: `Completed ${campaignName} (${leads.length} leads processed)`,
                    current_campaign_id: instantlyCampaignId,
                    current_campaign_name: campaignName,
                    total_leads_seen: totalLeadsSeen,
                    matched_leads: matchedLeads,
                    unmatched_leads: unmatchedLeads,
                    campaigns_completed: campaignsSynced,
                    phase: 'campaign_completed',
                    currentCampaignFetchedLeads: leads.length,
                    currentCampaignLeadTotal: leads.length,
                    currentCampaignProcessedLeads: leads.length,
                    currentCampaignMatchedLeads: matchedLeadsInCampaign,
                    currentCampaignUnmatchedLeads: unmatchedLeadsInCampaign
                });
            }
        }

        await updateClientState(sqlClientId, {
            instantly_last_synced_at: syncStartedAt,
            instantly_last_sync_error: null
        });

        if (syncAutoresponderTriggers.length) {
            logger(`Processing ${syncAutoresponderTriggers.length} interested autoresponder trigger(s) from sync reconcile`);
            await processSyncAutoresponderTriggers({
                agencyId,
                clientSlug,
                clientId: sqlClientId,
                triggers: syncAutoresponderTriggers,
                logger
            });
        }

        if (syncRunId) {
            await publishInstantlySyncProgress(syncRunId, {
                status: 'completed',
                progress_message: 'Sync completed',
                current_campaign_id: null,
                current_campaign_name: null,
                total_leads_seen: totalLeadsSeen,
                matched_leads: matchedLeads,
                unmatched_leads: unmatchedLeads,
                campaigns_completed: campaignsSynced,
                completed_at: new Date().toISOString(),
                phase: 'completed'
            });
        }

        return {
            clientId: sqlClientId,
            campaignsSynced,
            totalLeadsSeen,
            matchedLeads,
            unmatchedLeads,
            syncedAt: syncStartedAt
        };
    } catch (error) {
        if (error instanceof InstantlySyncCancelledError) {
            if (syncRunId) {
                const currentRow = await getInstantlySyncRunRowById(syncRunId);
                const metadata = mergeMetadataPatch(currentRow?.metadata, {
                    cancelledAt: new Date().toISOString(),
                    phase: 'cancelled'
                });
                await updateInstantlySyncRun(syncRunId, {
                    status: 'cancelled',
                    progress_message: 'Sync cancelled',
                    completed_at: new Date().toISOString(),
                    current_campaign_id: null,
                    current_campaign_name: null,
                    metadata
                });
            }
            return {
                clientId: sqlClientId,
                campaignsSynced: null,
                totalLeadsSeen: null,
                matchedLeads: null,
                unmatchedLeads: null,
                syncedAt: syncStartedAt,
                cancelled: true
            };
        }
        await updateClientState(sqlClientId, {
            instantly_last_sync_error: String(error?.message || error)
        });
        if (syncRunId) {
            await publishInstantlySyncProgress(syncRunId, {
                status: 'failed',
                progress_message: 'Sync failed',
                error: String(error?.message || error),
                completed_at: new Date().toISOString(),
                phase: 'failed'
            });
        }
        throw error;
    }
}

function replyInterestReconcileTimerKey(clientId, contactId, campaignId) {
    return `${clientId}::${contactId}::${campaignId}`;
}

function scheduleReplyInterestStatusReconcile({
    agencyId,
    clientSlug,
    clientId,
    contactId,
    campaignId,
    instantlyCampaignId,
    instantlyLeadId,
    leadEmail,
    replyEventId,
    replyEventTimestamp,
    logger = () => {}
}) {
    if (!INSTANTLY_REPLY_INTEREST_RECONCILE_ENABLED) return;
    if (!clientId || !contactId || !campaignId || !instantlyCampaignId) return;

    const timerKey = replyInterestReconcileTimerKey(clientId, contactId, campaignId);
    const existingTimer = replyInterestReconcileTimers.get(timerKey);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
        replyInterestReconcileTimers.delete(timerKey);
        void runReplyInterestStatusReconcile({
            agencyId,
            clientSlug,
            clientId,
            contactId,
            campaignId,
            instantlyCampaignId,
            instantlyLeadId,
            leadEmail,
            replyEventId,
            replyEventTimestamp,
            logger
        }).catch((error) => {
            logger(`[instantly-reply-reconcile] failed: ${error?.message || error}`);
        });
    }, INSTANTLY_REPLY_INTEREST_RECONCILE_DELAY_MS);

    replyInterestReconcileTimers.set(timerKey, timer);
    if (typeof timer.unref === 'function') timer.unref();
}

async function runReplyInterestStatusReconcile({
    agencyId,
    clientSlug,
    clientId,
    contactId,
    campaignId,
    instantlyCampaignId,
    instantlyLeadId,
    leadEmail,
    replyEventId,
    replyEventTimestamp,
    logger = () => {}
}) {
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');

        if (await hasRecentInterestStatusWebhookNearReply(dbClient, {
            contactId,
            campaignId,
            replyEventTimestamp
        })) {
            await dbClient.query('COMMIT');
            logger(
                `[instantly-reply-reconcile] skipped: interest status webhook received near reply`
                + ` contact=${contactId} campaign=${campaignId}`
            );
            return;
        }

        await dbClient.query('COMMIT');
    } catch (error) {
        await dbClient.query('ROLLBACK');
        throw error;
    } finally {
        dbClient.release();
    }

    const clientRow = await getClientRowBySlug(agencyId, clientSlug);
    const apiKey = asNullableText(clientRow?.instantly_key);
    if (!apiKey) {
        logger('[instantly-reply-reconcile] skipped: missing Instantly API key');
        return;
    }

    const lead = await fetchInstantlyLeadForReplyReconcile(apiKey, {
        instantlyCampaignId,
        leadId: instantlyLeadId,
        email: leadEmail
    });
    if (!lead) {
        logger('[instantly-reply-reconcile] skipped: lead not found in Instantly');
        return;
    }

    const nextInterestStatus = asNullableInt(lead?.lt_interest_status);
    const resolvedLeadId = asNullableText(lead?.id || instantlyLeadId);
    const eventTimestamp = asNullableTimestamp(lead?.timestamp_last_interest_change)
        || asNullableTimestamp(lead?.timestamp_updated)
        || new Date().toISOString();
    const normalizedLeadEmail = normalizeEmail(leadEmail);

    const reconcileClient = await pool.connect();
    try {
        await reconcileClient.query('BEGIN');

        const priorState = await loadContactCampaignInterestState(reconcileClient, contactId, campaignId);
        const previousInterestStatus = asNullableInt(priorState?.interest_status);

        if (!shouldApplyInterestStatusFromReplyReconcile({ previousInterestStatus, nextInterestStatus })) {
            await reconcileClient.query('COMMIT');
            logger(
                `[instantly-reply-reconcile] no interest status transition for contact=${contactId}`
                + ` campaign=${campaignId} (prior=${previousInterestStatus}, next=${nextInterestStatus})`
            );

            if (nextInterestStatus === 1 && replyEventId) {
                try {
                    await maybeCreatePostAutoresponderFollowUpDraft({
                        agencyId,
                        clientSlug,
                        clientId,
                        campaignId,
                        contactId,
                        instantlyLeadId: resolvedLeadId,
                        leadEmail: normalizedLeadEmail,
                        replyEventId,
                        interestStatus: nextInterestStatus,
                        logger
                    });
                } catch (draftError) {
                    logger(`[instantly-reply-reconcile] post-autoresponder follow-up failed: ${draftError.message}`);
                }
            }
            return;
        }

        const eventType = mapInterestStatusToEventType(nextInterestStatus);
        if (!eventType) {
            await reconcileClient.query('COMMIT');
            return;
        }

        const { eventId, eventPatch, deduplicated } = await insertReconcileInterestEvent(reconcileClient, {
            agencyId,
            clientId,
            contactId,
            campaignId,
            instantlyCampaignId,
            instantlyLeadId: resolvedLeadId,
            leadEmail: normalizedLeadEmail,
            eventType,
            eventTimestamp,
            previousInterestStatus,
            nextInterestStatus,
            reconcileSource: 'reply_reconcile',
            reconcileContext: {
                reply_event_id: replyEventId,
                reply_event_timestamp: replyEventTimestamp,
                checked_at: new Date().toISOString()
            }
        });

        if (deduplicated || !eventId) {
            await reconcileClient.query('COMMIT');
            return;
        }

        await applyInterestEventPatchToCampaign(reconcileClient, {
            contactId,
            campaignId,
            instantlyLeadId: resolvedLeadId,
            eventPatch
        });

        if (replyEventId && eventPatch.lastReplyCategory) {
            await reconcileClient.query(
                `UPDATE contact_instantly_events
                 SET reply_category = $2
                 WHERE id = $1
                 AND COALESCE(reply_category, '') IS DISTINCT FROM $2`,
                [replyEventId, eventPatch.lastReplyCategory]
            );
        }

        await reconcileClient.query('COMMIT');

        logger(
            `[instantly-reply-reconcile] recorded synthetic ${eventType} event=${eventId}`
            + ` contact=${contactId} campaign=${campaignId}`
            + ` (prior=${previousInterestStatus}, next=${nextInterestStatus})`
        );

        if (nextInterestStatus !== 1) {
            await cancelNonInterestedAutoResponderDrafts(pool, contactId, campaignId);
            return;
        }

        if (previousInterestStatus === 1) return;

        if (await hasOpenInterestedAutoresponderDraft(pool, contactId, campaignId)) {
            logger(
                `[instantly-reply-reconcile] skipped autoresponder: open draft`
                + ` contact=${contactId} campaign=${campaignId}`
            );
            return;
        }

        try {
            await createInterestedAutoResponderDraftFromEvent({
                agencyId,
                clientSlug,
                clientId,
                campaignId,
                contactId,
                instantlyLeadId: resolvedLeadId,
                sourceEventId: eventId,
                replySourceEventId: replyEventId,
                leadEmail: normalizedLeadEmail,
                logger
            });
        } catch (draftError) {
            logger(`[instantly-reply-reconcile] autoresponder failed: ${draftError.message}`);
        }
    } catch (error) {
        await reconcileClient.query('ROLLBACK');
        throw error;
    } finally {
        reconcileClient.release();
    }
}

export async function processInstantlyWebhookEvent({ agencyId, clientSlug, secret, event, logger = () => {} }) {
    const clientState = await resolveClientState(agencyId, clientSlug);
    if (!clientState) {
        const error = new Error('Client not found in SQL.');
        error.statusCode = 404;
        throw error;
    }

    const expectedSecret = asNullableText(clientState.instantly_webhook_secret);
    if (!expectedSecret || expectedSecret !== secret) {
        const error = new Error('Invalid Instantly webhook secret.');
        error.statusCode = 401;
        throw error;
    }

    const eventTimestamp = asNullableTimestamp(event?.timestamp) || new Date().toISOString();
    const normalizedEmail = normalizeEmail(event?.lead_email);
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const instantlyCampaignId = asNullableText(event?.campaign_id);
        const campaignName = asNullableText(event?.campaign_name);
        let sqlCampaignId = null;
        if (instantlyCampaignId) {
            sqlCampaignId = await upsertCampaign(client, {
                agencyId,
                clientId: clientState.id,
                instantlyCampaignId,
                name: campaignName || instantlyCampaignId,
                rawCampaignPayload: {
                    campaign_id: event?.campaign_id,
                    campaign_name: event?.campaign_name,
                    workspace: event?.workspace
                },
                lastSyncedAt: new Date().toISOString()
            });
        }

        let contactId = null;
        if (normalizedEmail) {
            const contactResult = await client.query(
                `SELECT id
                 FROM contacts
                 WHERE client_id = $1
                 AND LOWER(email) = $2
                 LIMIT 1`,
                [clientState.id, normalizedEmail]
            );
            contactId = Number(contactResult.rows[0]?.id || 0) || null;
        }

        if (!contactId && normalizedEmail) {
            contactId = await ensureInstantlyContact(client, {
                agencyId,
                clientId: clientState.id,
                campaign: {
                    instantlyCampaignId,
                    campaignName
                },
                lead: {
                    id: event?.lead_id || event?.instantly_lead_id,
                    email: normalizedEmail,
                    first_name: event?.first_name,
                    last_name: event?.last_name,
                    full_name: event?.lead_name || event?.full_name || event?.name
                },
                source: 'instantly_webhook'
            });
        }

        const fingerprint = buildEventFingerprint(event);
        const eventPatch = buildEventPatch(event, eventTimestamp);
        const replyToUuid = extractReplyToUuid(event);
        const insertEventResult = await client.query(
            `INSERT INTO contact_instantly_events (
                agency_id, client_id, contact_id, campaign_id, instantly_campaign_id, instantly_lead_id,
                event_type, reply_category, lead_email, email_account, unibox_url, step, variant,
                message_text, reply_text_snippet, reply_to_uuid, event_timestamp, fingerprint, source, payload
            )
            VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18, $19, $20::jsonb
            )
            ON CONFLICT (source, fingerprint) DO UPDATE
            SET reply_to_uuid = COALESCE(contact_instantly_events.reply_to_uuid, EXCLUDED.reply_to_uuid),
                email_account = COALESCE(contact_instantly_events.email_account, EXCLUDED.email_account),
                unibox_url = COALESCE(contact_instantly_events.unibox_url, EXCLUDED.unibox_url),
                message_text = COALESCE(contact_instantly_events.message_text, EXCLUDED.message_text),
                reply_text_snippet = COALESCE(contact_instantly_events.reply_text_snippet, EXCLUDED.reply_text_snippet),
                payload = CASE
                    WHEN contact_instantly_events.payload = '{}'::jsonb THEN EXCLUDED.payload
                    ELSE contact_instantly_events.payload
                END
            RETURNING id`,
            [
                agencyId,
                clientState.id,
                contactId,
                sqlCampaignId,
                asNullableText(event?.campaign_id),
                asNullableText(event?.lead_id || event?.instantly_lead_id),
                asNullableText(event?.event_type) || 'unknown',
                eventPatch.lastReplyCategory,
                normalizedEmail,
                asNullableText(event?.email_account),
                asNullableText(event?.unibox_url),
                asNullableInt(event?.step),
                asNullableInt(event?.variant),
                asNullableText(event?.message_text || event?.reply_text || event?.text),
                asNullableText(event?.reply_text_snippet),
                replyToUuid,
                eventTimestamp,
                fingerprint,
                'webhook',
                JSON.stringify(event || {})
            ]
        );

        if (!insertEventResult.rowCount) {
            await client.query('COMMIT');
            return {
                deduplicated: true,
                clientId: clientState.id,
                campaignId: sqlCampaignId,
                contactId
            };
        }

        if (contactId && sqlCampaignId) {
            const instantlyLeadId = asNullableText(event?.lead_id || event?.instantly_lead_id);
            if (instantlyLeadId) {
                await deleteCampaignMembershipsByInstantlyLead(client, [
                    { campaign_id: sqlCampaignId, instantly_lead_id: instantlyLeadId }
                ]);
            }
            await client.query(
                `INSERT INTO contact_instantly_campaigns (
                    contact_id, campaign_id, upload_source, instantly_lead_id, active, last_seen_at, removed_at,
                    lead_status, lead_status_label, interest_status, interest_status_label,
                    timestamp_last_contact, timestamp_last_open, timestamp_last_reply, timestamp_last_interest_change, timestamp_last_click,
                    last_reply_category, last_event_type, last_bounce_at, last_unsubscribe_at,
                    last_synced_at, email_open_count, email_reply_count, email_click_count
                )
                VALUES (
                    $1, $2, 'instantly_webhook', $3, TRUE, NOW(), NULL,
                    $4, $5, $6, $7,
                    $8, $9, $10, $11, $12,
                    $13, $14, $15, $16,
                    NOW(), $17, $18, $19
                )
                ON CONFLICT (contact_id, campaign_id)
                DO UPDATE SET
                    instantly_lead_id = COALESCE(EXCLUDED.instantly_lead_id, contact_instantly_campaigns.instantly_lead_id),
                    active = TRUE,
                    last_seen_at = NOW(),
                    removed_at = NULL,
                    lead_status = COALESCE(EXCLUDED.lead_status, contact_instantly_campaigns.lead_status),
                    lead_status_label = COALESCE(EXCLUDED.lead_status_label, contact_instantly_campaigns.lead_status_label),
                    interest_status = COALESCE(EXCLUDED.interest_status, contact_instantly_campaigns.interest_status),
                    interest_status_label = COALESCE(EXCLUDED.interest_status_label, contact_instantly_campaigns.interest_status_label),
                    timestamp_last_contact = COALESCE(EXCLUDED.timestamp_last_contact, contact_instantly_campaigns.timestamp_last_contact),
                    timestamp_last_open = COALESCE(EXCLUDED.timestamp_last_open, contact_instantly_campaigns.timestamp_last_open),
                    timestamp_last_reply = COALESCE(EXCLUDED.timestamp_last_reply, contact_instantly_campaigns.timestamp_last_reply),
                    timestamp_last_interest_change = COALESCE(EXCLUDED.timestamp_last_interest_change, contact_instantly_campaigns.timestamp_last_interest_change),
                    timestamp_last_click = COALESCE(EXCLUDED.timestamp_last_click, contact_instantly_campaigns.timestamp_last_click),
                    last_reply_category = COALESCE(EXCLUDED.last_reply_category, contact_instantly_campaigns.last_reply_category),
                    last_event_type = EXCLUDED.last_event_type,
                    last_bounce_at = COALESCE(EXCLUDED.last_bounce_at, contact_instantly_campaigns.last_bounce_at),
                    last_unsubscribe_at = COALESCE(EXCLUDED.last_unsubscribe_at, contact_instantly_campaigns.last_unsubscribe_at),
                    last_synced_at = NOW(),
                    email_open_count = contact_instantly_campaigns.email_open_count + EXCLUDED.email_open_count,
                    email_reply_count = contact_instantly_campaigns.email_reply_count + EXCLUDED.email_reply_count,
                    email_click_count = contact_instantly_campaigns.email_click_count + EXCLUDED.email_click_count`,
                [
                    contactId,
                    sqlCampaignId,
                    asNullableText(event?.lead_id || event?.instantly_lead_id),
                    eventPatch.leadStatus,
                    eventPatch.leadStatusLabel,
                    eventPatch.interestStatus,
                    eventPatch.interestStatusLabel,
                    eventPatch.timestampLastContact,
                    eventPatch.timestampLastOpen,
                    eventPatch.timestampLastReply,
                    eventPatch.timestampLastInterestChange,
                    eventPatch.timestampLastClick,
                    eventPatch.lastReplyCategory,
                    eventPatch.lastEventType,
                    eventPatch.lastBounceAt,
                    eventPatch.lastUnsubscribeAt,
                    eventPatch.openDelta,
                    eventPatch.replyDelta,
                    eventPatch.clickDelta
                ]
            );

            if (eventPatch.timestampLastContact) {
                await client.query(
                    `UPDATE contacts
                     SET last_contacted_at = $2,
                         updated_at = NOW()
                     WHERE id = $1
                     AND (last_contacted_at IS NULL OR last_contacted_at < $2::timestamptz)`,
                    [contactId, eventPatch.timestampLastContact]
                );
            }

            await cancelNonInterestedAutoResponderDrafts(client, contactId, sqlCampaignId);
        }

        const workspaceId = asNullableText(event?.workspace) || clientState.instantly_workspace_id;
        const syncedAt = new Date().toISOString();
        await client.query(
            `UPDATE clients
             SET instantly_workspace_id = COALESCE($2, instantly_workspace_id),
                 instantly_last_synced_at = $3,
                 instantly_last_sync_error = NULL
             WHERE id = $1`,
            [clientState.id, workspaceId, syncedAt]
        );

        await client.query('COMMIT');

        const insertedEventId = insertEventResult.rows[0]?.id || null;
        const normalizedEventType = asNullableText(event?.event_type)?.toLowerCase();
        if (normalizedEventType === 'lead_interested' && insertedEventId && sqlCampaignId && contactId) {
            try {
                await createInterestedAutoResponderDraftFromEvent({
                    agencyId,
                    clientSlug,
                    clientId: clientState.id,
                    campaignId: sqlCampaignId,
                    contactId,
                    instantlyLeadId: asNullableText(event?.lead_id || event?.instantly_lead_id),
                    sourceEventId: insertedEventId,
                    leadEmail: normalizedEmail,
                    logger
                });
            } catch (draftError) {
                logger(`Interested auto-responder draft creation failed: ${draftError.message}`);
            }
        }

        if (
            isInstantlyReplyWebhookEvent(event?.event_type)
            && insertedEventId
            && sqlCampaignId
            && contactId
            && instantlyCampaignId
        ) {
            scheduleReplyInterestStatusReconcile({
                agencyId,
                clientSlug,
                clientId: clientState.id,
                contactId,
                campaignId: sqlCampaignId,
                instantlyCampaignId,
                instantlyLeadId: asNullableText(event?.lead_id || event?.instantly_lead_id),
                leadEmail: normalizedEmail,
                replyEventId: insertedEventId,
                replyEventTimestamp: eventTimestamp,
                logger
            });
            logger(
                `[instantly-reply-reconcile] scheduled interest check in ${INSTANTLY_REPLY_INTEREST_RECONCILE_DELAY_MS}ms`
                + ` for contact=${contactId} campaign=${sqlCampaignId}`
            );

            try {
                await maybeCreatePostAutoresponderFollowUpDraft({
                    agencyId,
                    clientSlug,
                    clientId: clientState.id,
                    campaignId: sqlCampaignId,
                    contactId,
                    instantlyLeadId: asNullableText(event?.lead_id || event?.instantly_lead_id),
                    leadEmail: normalizedEmail,
                    replyEventId: insertedEventId,
                    replyCategory: eventPatch.lastReplyCategory,
                    logger
                });
            } catch (draftError) {
                logger(`Post-autoresponder follow-up draft creation failed: ${draftError.message}`);
            }
        }

        logger(`Stored Instantly webhook event ${event?.event_type || 'unknown'} for ${agencyId}/${clientSlug}`);
        return {
            deduplicated: false,
            clientId: clientState.id,
            campaignId: sqlCampaignId,
            contactId
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function listInstantlySyncClients() {
    const rows = await listClientsWithInstantlyKey();
    return rows.map((row) => ({
        clientId: row.clientId,
        agencyId: row.agencyId,
        clientSlug: row.clientSlug,
        instantlyKey: row.instantlyKey
    }));
}

/**
 * Send a reply via the Instantly V2 reply endpoint.
 * Uses the shared rate-limited, retrying HTTP helper.
 *
 * @param {string} apiKey       Client Instantly API key.
 * @param {object} replyPayload Fields required by POST /api/v2/emails/reply:
 *                              reply_to_uuid, eaccount, subject, body { html, text }
 */
export async function sendInstantlyReply(apiKey, replyPayload) {
    return instantlyRequest({
        apiKey,
        path: '/api/v2/emails/reply',
        method: 'POST',
        body: replyPayload
    });
}

const LEAD_LABELS_PAGE_LIMIT = 100;
const LEAD_LABELS_MAX_PAGES = 10;

/**
 * List the workspace's custom lead labels (interest statuses) via
 * GET /api/v2/lead-labels, following pagination. Returns raw label objects
 * ({ label, interest_status, interest_status_label, description, ... }).
 *
 * @param {string} apiKey Client Instantly API key.
 */
export async function listInstantlyLeadLabels(apiKey) {
    const labels = [];
    let startingAfter = null;

    for (let page = 0; page < LEAD_LABELS_MAX_PAGES; page += 1) {
        const params = new URLSearchParams({ limit: String(LEAD_LABELS_PAGE_LIMIT) });
        if (startingAfter) params.set('starting_after', startingAfter);

        const data = await instantlyRequest({
            apiKey,
            path: `/api/v2/lead-labels?${params.toString()}`,
            method: 'GET'
        });

        const items = Array.isArray(data?.items)
            ? data.items
            : (Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []));
        labels.push(...items);

        const nextCursor = asNullableText(data?.next_starting_after);
        if (items.length < LEAD_LABELS_PAGE_LIMIT || !nextCursor || nextCursor === startingAfter) {
            break;
        }
        startingAfter = nextCursor;
    }

    return labels;
}

/**
 * Set a lead's interest status via POST /api/v2/leads/update-interest-status.
 * interestValue is the workspace-specific numeric value (custom labels included).
 *
 * @param {string} apiKey Client Instantly API key.
 * @param {object} params { campaignId, leadEmail, interestValue }
 */
export async function updateInstantlyLeadInterestStatus(apiKey, { campaignId, leadEmail, interestValue }) {
    return instantlyRequest({
        apiKey,
        path: '/api/v2/leads/update-interest-status',
        method: 'POST',
        body: {
            campaign_id: campaignId,
            lead_email: leadEmail,
            interest_value: interestValue
        }
    });
}
