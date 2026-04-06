import crypto from 'crypto';
import { firestore } from '../config/firebase.js';
import { pool } from '../config/db.js';
import { getOrCreateClient } from './db/queries.js';

const INSTANTLY_API_BASE_URL = 'https://api.instantly.ai';
const INSTANTLY_SYNC_PAGE_LIMIT = Math.max(1, Math.min(parseInt(process.env.INSTANTLY_SYNC_PAGE_LIMIT || '100', 10) || 100, 100));
const INSTANTLY_REQUEST_TIMEOUT_MS = Math.max(parseInt(process.env.INSTANTLY_REQUEST_TIMEOUT_MS || '20000', 10) || 20000, 1000);
const INSTANTLY_RATE_LIMIT_PER_SECOND = Math.max(parseInt(process.env.INSTANTLY_RATE_LIMIT_PER_SECOND || '20', 10) || 20, 1);
const INSTANTLY_MAX_RETRIES = Math.max(parseInt(process.env.INSTANTLY_MAX_RETRIES || '4', 10) || 4, 0);
const INSTANTLY_RETRY_BASE_DELAY_MS = Math.max(parseInt(process.env.INSTANTLY_RETRY_BASE_DELAY_MS || '1000', 10) || 1000, 100);
const INSTANTLY_SYNC_PROGRESS_BATCH_SIZE = Math.max(parseInt(process.env.INSTANTLY_SYNC_PROGRESS_BATCH_SIZE || '25', 10) || 25, 1);
const INSTANTLY_MIN_REQUEST_INTERVAL_MS = Math.max(Math.ceil(1000 / INSTANTLY_RATE_LIMIT_PER_SECOND), 1);
const instantlyNextRequestAtByKey = new Map();
const instantlyAbortControllersByRunId = new Map();

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

function deriveSnapshotFromLead(lead, syncedAt) {
    const leadStatus = asNullableInt(lead?.status);
    const interestStatus = asNullableInt(lead?.lt_interest_status);
    return {
        instantlyLeadId: asNullableText(lead?.id),
        active: true,
        lastSeenAt: syncedAt,
        leadStatus,
        leadStatusLabel: mapLeadStatusLabel(leadStatus),
        interestStatus,
        interestStatusLabel: mapInterestStatusLabel(interestStatus),
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
        lead_no_show: -4
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

async function fetchInstantlyCampaigns(apiKey, { syncRunId = null } = {}) {
    const payload = await instantlyRequest({
        apiKey,
        path: '/api/v2/campaigns',
        method: 'GET',
        syncRunId
    });
    return extractItems(payload);
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
    const clientId = await getOrCreateClient(agencyId, clientSlug);
    const result = await pool.query(
        `SELECT id, name, instantly_workspace_id, instantly_webhook_id, instantly_webhook_secret,
                instantly_webhook_url, instantly_webhook_status, instantly_sync_enabled,
                instantly_last_synced_at, instantly_last_sync_error
         FROM clients
         WHERE id = $1 AND agency_id = $2`,
        [clientId, agencyId]
    );
    return result.rows[0] || null;
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
    return normalizeSyncRunRow(result.rows[0] || null);
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
    return normalizeSyncRunRow(result.rows[0] || null);
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

export async function beginInstantlySyncRun({ agencyId, clientSlug, instantlyKey, triggerSource = 'manual', logger = () => {} }) {
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
            syncRunId: created.run.id,
            logger
        }).catch((error) => {
            logger(`Sync run ${created.run.id} failed: ${error?.message || error}`);
        });
    }

    return created;
}

export async function runInstantlySyncJob({ agencyId, clientSlug, instantlyKey, triggerSource = 'scheduled', logger = () => {} }) {
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
        source
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

async function upsertCampaignSnapshots(db, rows) {
    if (!rows.length) return;
    await db.query(
        `WITH input AS (
            SELECT *
            FROM jsonb_to_recordset($1::jsonb) AS x(
                contact_id BIGINT,
                campaign_id BIGINT,
                upload_source TEXT,
                instantly_lead_id TEXT,
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
                last_synced_at TIMESTAMPTZ
            )
        )
        INSERT INTO contact_instantly_campaigns (
            contact_id, campaign_id, upload_source, instantly_lead_id, active, last_seen_at, removed_at,
            lead_status, lead_status_label, interest_status, interest_status_label, verification_status,
            email_open_count, email_reply_count, email_click_count,
            timestamp_last_contact, timestamp_last_open, timestamp_last_reply, timestamp_last_interest_change, timestamp_last_click,
            last_contacted_from, last_step_from, last_step_id, last_step_timestamp_executed,
            status_summary, status_summary_subseq, raw_lead_payload,
            last_reply_category, last_event_type, last_bounce_at, last_unsubscribe_at, last_synced_at
        )
        SELECT
            contact_id, campaign_id, upload_source, instantly_lead_id, active, last_seen_at, NULL,
            lead_status, lead_status_label, interest_status, interest_status_label, verification_status,
            email_open_count, email_reply_count, email_click_count,
            timestamp_last_contact, timestamp_last_open, timestamp_last_reply, timestamp_last_interest_change, timestamp_last_click,
            last_contacted_from, last_step_from, last_step_id, last_step_timestamp_executed,
            status_summary, status_summary_subseq, raw_lead_payload,
            last_reply_category, last_event_type, last_bounce_at, last_unsubscribe_at, last_synced_at
        FROM input
        ON CONFLICT (contact_id, campaign_id)
        DO UPDATE SET
            instantly_lead_id = COALESCE(EXCLUDED.instantly_lead_id, contact_instantly_campaigns.instantly_lead_id),
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
            last_synced_at = COALESCE(EXCLUDED.last_synced_at, contact_instantly_campaigns.last_synced_at)`,
        [JSON.stringify(rows)]
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

export async function syncClientInstantlyState({ agencyId, clientSlug, instantlyKey, syncRunId = null, logger = () => {} }) {
    const sqlClientId = await getOrCreateClient(agencyId, clientSlug);
    const syncStartedAt = new Date().toISOString();

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

        const campaigns = await fetchInstantlyCampaigns(instantlyKey, { syncRunId });
        logger(`Fetched ${campaigns.length} Instantly campaigns for ${agencyId}/${clientSlug}`);
        if (syncRunId) {
            await publishInstantlySyncProgress(syncRunId, {
                progress_message: campaigns.length
                    ? `Fetched ${campaigns.length} campaign(s) from Instantly`
                    : 'No Instantly campaigns found',
                total_campaigns: campaigns.length,
                phase: 'processing_campaigns'
            });
        }

        let totalLeadsSeen = 0;
        let matchedLeads = 0;
        let unmatchedLeads = 0;
        let campaignsSynced = 0;

        for (const campaign of campaigns) {
            await assertSyncRunNotCancelled(syncRunId);
            const instantlyCampaignId = asNullableText(campaign?.id || campaign?.campaignId || campaign?.uuid || campaign?._id);
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
                const snapshot = deriveSnapshotFromLead(lead, syncStartedAt);
                matchedSnapshots.push({
                    contact_id: contactId,
                    campaign_id: sqlCampaignId,
                    upload_source: 'instantly_sync',
                    instantly_lead_id: snapshot.instantlyLeadId,
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
                    await upsertCampaignSnapshots(client, matchedSnapshots);
                    await updateContactLastContacted(client, matchedSnapshots);
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
        const insertEventResult = await client.query(
            `INSERT INTO contact_instantly_events (
                agency_id, client_id, contact_id, campaign_id, instantly_campaign_id, instantly_lead_id,
                event_type, reply_category, lead_email, email_account, unibox_url, step, variant,
                message_text, event_timestamp, fingerprint, source, payload
            )
            VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18::jsonb
            )
            ON CONFLICT (source, fingerprint) DO NOTHING
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
        }

        await client.query('COMMIT');

        await updateClientState(clientState.id, {
            instantly_workspace_id: asNullableText(event?.workspace) || clientState.instantly_workspace_id,
            instantly_last_synced_at: new Date().toISOString(),
            instantly_last_sync_error: null
        });

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
    const snapshot = await firestore.collectionGroup('clients').get();
    return snapshot.docs
        .map((doc) => {
            const parent = doc.ref.parent?.parent;
            const agencyId = parent?.id || null;
            const instantlyKey = asNullableText(doc.data()?.instantly_key);
            return {
                agencyId,
                clientSlug: doc.id,
                instantlyKey
            };
        })
        .filter((item) => item.agencyId && item.clientSlug && item.instantlyKey);
}
