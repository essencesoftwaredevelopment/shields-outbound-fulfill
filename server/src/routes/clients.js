/**
 * Clients/Agency API endpoints (Firestore-based orchestration layer)
 *
 * CANONICAL AGENCY IDENTIFIER RULE:
 * The Firestore users/{uid} document ID is the canonical agency identifier.
 * This same Firebase Auth uid is used directly as agency_id in all PostgreSQL tables.
 * No reconciliation or mapping is required.
 *
 * Note: This route manages Firestore collections (orchestration and UI state).
 * PostgreSQL tables are managed by the jobs service and are scoped by agency_id derived from
 * the verified Firebase token.
 */

import express from 'express';
import multer from 'multer';
import { parse as csvParse } from 'csv-parse/sync';
import { admin, firestore } from '../config/firebase.js';
import { pool } from '../config/db.js';
import { getOrCreateClient } from '../services/db/queries.js';
import {
    beginInstantlySyncRun,
    buildInstantlyWebhookTargetUrl,
    getInstantlySyncRun,
    getLatestInstantlySyncRun,
    requestStopInstantlySyncRun,
    registerInstantlyWebhook
} from '../services/instantlyState.js';
import {
    choosePreferredCampaign,
    extractCampaignApiItems,
    getCsvValueByAliases,
    mapCsvEmailStatus,
    normalizeCampaignName,
    normalizeDomainForMatch,
    normalizeEmailForMatch,
    normalizeHeaderKey,
    normalizePersonName,
    shouldBackfillEmailStatus
} from '../utils/instantlyImportMerge.js';

const router = express.Router();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
});

const CAMPAIGN_NAME_ALIASES = ['campaign name', 'campaign', 'campaign_name'];
const EMAIL_ALIASES = ['email', 'email address', 'lead email'];
const DOMAIN_ALIASES = ['domain', 'website', 'company domain', 'company website', 'url'];
const NAME_ALIASES = ['founder name', 'full name', 'name', 'founder_name', 'full_name'];
const FIRST_NAME_ALIASES = ['first name', 'first_name'];
const LAST_NAME_ALIASES = ['last name', 'last_name'];
const EMAIL_STATUS_ALIASES = ['email_status', 'email status', 'verification status', 'lookup_status'];
const MAX_BIND_PARAMS_PER_QUERY = 30000;
const DEFAULT_SUPABASE_URL = process.env.SUPABASE_URL || 'https://xfamwraegljpmvsdimrp.supabase.co';
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    || 'sb_publishable_d2nU2wfLmfxCa4fjdyhRrw_T3pHokH3';
const INSTANTLY_ANALYTICS_PERIODS = {
    '24h': {
        period: '24h',
        label: 'Last 24 hours',
        bucketUnit: 'hour',
        bucketStartSql: `DATE_TRUNC('hour', NOW() - INTERVAL '23 hours')`,
        bucketEndSql: `DATE_TRUNC('hour', NOW())`,
        eventFloorSql: `NOW() - INTERVAL '24 hours'`,
        bucketTruncSql: `DATE_TRUNC('hour', cie.event_timestamp)`,
        bucketLabelSql: `TO_CHAR(hours.bucket, 'HH24:00')`
    },
    '7d': {
        period: '7d',
        label: 'Last 7 days',
        bucketUnit: 'day',
        bucketStartSql: `DATE_TRUNC('day', NOW() - INTERVAL '6 days')`,
        bucketEndSql: `DATE_TRUNC('day', NOW())`,
        eventFloorSql: `NOW() - INTERVAL '7 days'`,
        bucketTruncSql: `DATE_TRUNC('day', cie.event_timestamp)`,
        bucketLabelSql: `TO_CHAR(hours.bucket, 'Mon DD')`
    },
    '30d': {
        period: '30d',
        label: 'Last 30 days',
        bucketUnit: 'day',
        bucketStartSql: `DATE_TRUNC('day', NOW() - INTERVAL '29 days')`,
        bucketEndSql: `DATE_TRUNC('day', NOW())`,
        eventFloorSql: `NOW() - INTERVAL '30 days'`,
        bucketTruncSql: `DATE_TRUNC('day', cie.event_timestamp)`,
        bucketLabelSql: `TO_CHAR(hours.bucket, 'Mon DD')`
    },
    '90d': {
        period: '90d',
        label: 'Last 90 days',
        bucketUnit: 'day',
        bucketStartSql: `DATE_TRUNC('day', NOW() - INTERVAL '89 days')`,
        bucketEndSql: `DATE_TRUNC('day', NOW())`,
        eventFloorSql: `NOW() - INTERVAL '90 days'`,
        bucketTruncSql: `DATE_TRUNC('day', cie.event_timestamp)`,
        bucketLabelSql: `TO_CHAR(hours.bucket, 'Mon DD')`
    }
};
const INSTANTLY_EVENT_TYPE_LABELS = {
    all: 'All event types',
    email_sent: 'Email Sent',
    email_opened: 'Email Opened',
    email_link_clicked: 'Link Clicked',
    reply_received: 'Reply Received',
    email_bounced: 'Email Bounced',
    lead_unsubscribed: 'Unsubscribed',
    lead_interested: 'Interested',
    lead_meeting_booked: 'Meeting Booked',
    lead_meeting_completed: 'Meeting Completed',
    lead_closed: 'Closed Won',
    lead_out_of_office: 'Out of Office',
    lead_not_interested: 'Not Interested',
    lead_wrong_person: 'Wrong Person',
    lead_neutral: 'Neutral',
    lead_no_show: 'No Show',
    state_sync: 'State Sync',
    unknown: 'Unknown'
};

function normalizeInstantlyEventType(eventType) {
    const normalized = String(eventType || '').trim().toLowerCase();
    if (!normalized) return 'unknown';
    if (normalized === 'reply' || normalized === 'replied') return 'reply_received';
    if (normalized.includes('bounce')) return 'email_bounced';
    return normalized;
}

function formatInstantlyEventTypeLabel(eventType) {
    const normalized = normalizeInstantlyEventType(eventType);
    if (INSTANTLY_EVENT_TYPE_LABELS[normalized]) {
        return INSTANTLY_EVENT_TYPE_LABELS[normalized];
    }

    return normalized
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function buildInstantlyEventTypeFilterClause(eventType, tableAlias, placeholder) {
    const normalized = normalizeInstantlyEventType(eventType);
    if (!normalized || normalized === 'all') {
        return { clause: '', params: [], normalized: 'all' };
    }
    if (normalized === 'reply_received') {
        return {
            clause: ` AND LOWER(COALESCE(${tableAlias}.event_type, '')) IN ('reply_received', 'reply', 'replied')`,
            params: [],
            normalized
        };
    }
    if (normalized === 'email_bounced') {
        return {
            clause: ` AND LOWER(COALESCE(${tableAlias}.event_type, '')) LIKE '%bounce%'`,
            params: [],
            normalized
        };
    }

    return {
        clause: ` AND LOWER(COALESCE(${tableAlias}.event_type, '')) = ${placeholder}`,
        params: [normalized],
        normalized
    };
}

function setNoStoreHeaders(res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
}

function chunkArray(items, size) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

function buildHeaderLookup(rows) {
    const firstRow = rows[0] || {};
    const headerLookup = new Map();
    Object.keys(firstRow).forEach((header) => {
        const normalized = normalizeHeaderKey(header);
        if (!normalized || headerLookup.has(normalized)) return;
        headerLookup.set(normalized, header);
    });
    return headerLookup;
}

function hasAnyHeaderAlias(headerLookup, aliases) {
    return aliases.some((alias) => headerLookup.has(normalizeHeaderKey(alias)));
}

function extractContactNameFromRow(row, headerLookup) {
    const directName = getCsvValueByAliases(row, NAME_ALIASES, headerLookup);
    if (directName) return directName;

    const firstName = getCsvValueByAliases(row, FIRST_NAME_ALIASES, headerLookup);
    const lastName = getCsvValueByAliases(row, LAST_NAME_ALIASES, headerLookup);
    return `${firstName} ${lastName}`.trim();
}

async function deleteAllDocs(ref) {
    const batchSize = 300;
    let lastDoc = null;
    while (true) {
        let query = ref.orderBy('__name__').limit(batchSize);
        if (lastDoc) query = query.startAfter(lastDoc);
        const snap = await query.get();
        if (snap.empty) break;
        const batch = firestore.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        lastDoc = snap.docs[snap.docs.length - 1];
        if (snap.size < batchSize) break;
    }
}

async function verifyAgencyIdFromRequest(req) {
    const authHeader = String(req.headers.authorization || '').trim();
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const idToken = bearerMatch?.[1] || String(req.query?.idToken || req.body?.idToken || '').trim();
    if (!idToken) {
        const error = new Error('Missing ID token.');
        error.statusCode = 400;
        throw error;
    }

    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.uid;
}

// Create client via server (uses Admin SDK; bypasses client-side rules)
router.post('/clients', async (req, res) => {
    try {
        const { idToken, name, industry, instantly_key } = req.body || {};
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Client name is required.' });
        const allowedIndustries = new Set(['ecom', 'saas', 'agency', 'local']);
        const industryVal = typeof industry === 'string' ? industry : '';
        if (!allowedIndustries.has(industryVal)) return res.status(400).json({ error: 'Invalid industry.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const slug = name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 60);
        const clientRef = firestore.collection('users').doc(uid).collection('clients').doc(slug);
        await clientRef.set({
            id: slug,
            name: name.trim(),
            industry: industryVal,
            instantly_key: (instantly_key || '').toString().trim(),
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        res.status(201).json({ id: slug });
    } catch (error) {
        console.error('Client creation error:', error);
        res.status(500).json({ error: 'Failed to create client.' });
    }
});

// Delete a client and cascade delete known subcollections
router.post('/clients/:id/delete', async (req, res) => {
    try {
        const { idToken } = req.body || {};
        const clientId = req.params.id;
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client id.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const clientRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId);
        const subs = ['processed-domains', 'leads'];
        for (const sub of subs) {
            const colRef = clientRef.collection(sub);
            await deleteAllDocs(colRef);
        }
        await clientRef.delete();
        res.json({ ok: true });
    } catch (error) {
        console.error('Client cascade delete error:', error);
        res.status(500).json({ error: 'Failed to delete client.' });
    }
});

// Fetch Instantly campaigns for a client and store as subcollection 'campaigns'
router.post('/clients/:id/campaigns', async (req, res) => {
    try {
        console.log('[campaigns] incoming request', {
            path: req.path,
            params: req.params,
            hasBody: !!req.body,
        });
        const { idToken } = req.body || {};
        const clientId = req.params.id;
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client id.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;
        console.log('[campaigns] verified user', { uid, clientId });

        const clientRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId);
        const clientSnap = await clientRef.get();
        if (!clientSnap.exists) return res.status(404).json({ error: 'Client not found.' });
        const instantlyKey = (clientSnap.data()?.instantly_key || '').toString().trim();
        if (!instantlyKey) return res.status(400).json({ error: 'Client is missing Instantly API key.' });

        // Fetch campaigns from Instantly API (prefer v2) for last N days
        const daysStr = (req.query?.days || '').toString();
        const days = Number.isFinite(Number(daysStr)) && Number(daysStr) > 0 ? Number(daysStr) : 90;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        console.log('[campaigns] window', { days, since: since.toISOString() });
        let campaigns = [];
        async function fetchInstantlyCampaignsV2(key) {
            console.log('[campaigns] calling Instantly v2');
            const resp = await fetch('https://api.instantly.ai/api/v2/campaigns', {
                method: 'GET',
                headers: {
                    // v2 expects Authorization Bearer
                    'Authorization': `Bearer ${key}`,
                    'Accept': 'application/json'
                }
            });
            console.log('[campaigns] v2 response', { status: resp.status });
            if (!resp.ok) {
                const msg = await resp.text().catch(() => '');
                throw new Error(`Instantly v2 error (${resp.status}): ${msg}`);
            }
            const data = await resp.json();
            // v2 returns { items: [...] } (observed), but support other shapes defensively
            const items = Array.isArray(data?.items)
                ? data.items
                : (Array.isArray(data?.data)
                    ? data.data
                    : (Array.isArray(data?.campaigns)
                        ? data.campaigns
                        : (Array.isArray(data) ? data : [])));
            if (Array.isArray(items) && items.length > 0) {
                const sample = items[0];
                console.log('[campaigns] v2 sample keys', Object.keys(sample || {}));
            }
            return items;
        }
        try {
            let items = [];
            try {
                items = await fetchInstantlyCampaignsV2(instantlyKey);
            } catch (e2) {
                console.warn('Instantly v2 failed:', e2?.message || e2);
                // Do not fallback to v1 since route may be deprecated; surface error
                throw e2;
            }
            console.log('[campaigns] fetched items', { count: Array.isArray(items) ? items.length : 0 });
            campaigns = items.filter(c => {
                const createdRaw = c.timestamp_created || c.createdAt || c.created_at || c.created || c.created_at_utc || null;
                const created = createdRaw ? new Date(createdRaw) : null;
                return created && created instanceof Date && !isNaN(created.getTime()) && created >= since;
            });
            console.log('[campaigns] filtered items (lastNd)', { count: campaigns.length });
        } catch (err) {
            console.error('Instantly fetch campaigns error:', err?.message);
            return res.status(502).json({ error: 'Failed to fetch campaigns from Instantly.' });
        }

        // Upsert campaigns into subcollection
        const colRef = clientRef.collection('campaigns');
        const batch = firestore.batch();
        campaigns.forEach((c) => {
            const id = (c.id || c.campaignId || c.uuid || c._id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`).toString();
            const ref = colRef.doc(id);
            const created = c.timestamp_created || c.createdAt || c.created_at || c.created || c.created_at_utc || null;
            batch.set(ref, {
                id,
                name: c.name || c.title || c.campaign_name || '',
                status: typeof c.status !== 'undefined' ? c.status : (c.state || ''),
                createdAt: created ? new Date(created).toISOString() : null,
                raw: c,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        });
        await batch.commit();
        console.log('[campaigns] upsert complete', { uid, clientId, wrote: campaigns.length });

        // Sync campaigns to SQL (instantly_campaigns table)
        try {
            if (campaigns.length > 0) {
                const sqlClientId = await getOrCreateClient(uid, clientId);

                // Build bulk upsert query
                const values = [];
                const params = [];
                let paramIndex = 1;

                campaigns.forEach((c) => {
                    const instantlyId = (c.id || c.campaignId || c.uuid || c._id || '').toString();
                    const name = c.name || c.title || c.campaign_name || '';
                    const created = c.timestamp_created || c.createdAt || c.created_at || c.created || c.created_at_utc || null;
                    const startDate = created ? new Date(created) : null;

                    params.push(uid, sqlClientId, instantlyId, name, startDate, typeof c.status !== 'undefined' ? Number(c.status) : (c.state ?? null), JSON.stringify(c));
                    values.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}::jsonb, NOW())`);
                    paramIndex += 7;
                });

                const query = `
                    INSERT INTO instantly_campaigns (
                        agency_id, client_id, instantly_campaign_id, name, start_date, status, raw_campaign_payload, last_synced_at
                    )
                    VALUES ${values.join(', ')}
                    ON CONFLICT (agency_id, client_id, instantly_campaign_id)
                    DO UPDATE SET 
                        name = EXCLUDED.name,
                        start_date = COALESCE(EXCLUDED.start_date, instantly_campaigns.start_date),
                        status = COALESCE(EXCLUDED.status, instantly_campaigns.status),
                        raw_campaign_payload = EXCLUDED.raw_campaign_payload,
                        last_synced_at = EXCLUDED.last_synced_at
                `;

                await pool.query(query, params);
                console.log('[campaigns] synced to SQL', { count: campaigns.length, sqlClientId });
            }
        } catch (sqlErr) {
            console.error('[campaigns] failed to sync to SQL', sqlErr?.message || sqlErr);
            // Don't fail the request if SQL sync fails
        }

        // Update client doc with active campaigns count (status === 1)
        try {
            const activeCount = campaigns.filter(c => {
                const statusVal = typeof c.status !== 'undefined' ? c.status : (c.state || null);
                return Number(statusVal) === 1;
            }).length;
            await clientRef.set({
                activeCampaigns: activeCount,
                campaignsLastSynced: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            console.log('[campaigns] client activeCampaigns updated', { clientId, activeCount });
        } catch (e) {
            console.warn('[campaigns] failed to set activeCampaigns', e?.message || e);
        }

        // Return count
        res.json({ count: campaigns.length });
    } catch (error) {
        console.error('Client campaigns sync error:', error);
        res.status(500).json({ error: 'Failed to sync campaigns.' });
    }
});

router.post('/clients/:id/instantly/webhook', async (req, res) => {
    try {
        const { idToken, rotateSecret = false } = req.body || {};
        const clientSlug = req.params.id;
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientSlug) return res.status(400).json({ error: 'Missing client id.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const agencyId = decoded.uid;

        const clientRef = firestore.collection('users').doc(agencyId).collection('clients').doc(clientSlug);
        const clientSnap = await clientRef.get();
        if (!clientSnap.exists) return res.status(404).json({ error: 'Client not found.' });

        const instantlyKey = String(clientSnap.data()?.instantly_key || '').trim();
        if (!instantlyKey) return res.status(400).json({ error: 'Client is missing Instantly API key.' });

        const targetUrl = buildInstantlyWebhookTargetUrl(req, agencyId, clientSlug);
        if (!targetUrl) return res.status(400).json({ error: 'Could not determine webhook target URL.' });

        await getOrCreateClient(agencyId, clientSlug);
        const result = await registerInstantlyWebhook({
            agencyId,
            clientSlug,
            instantlyKey,
            targetUrl,
            rotateSecret: !!rotateSecret
        });

        await clientRef.set({
            instantlyWebhookId: result.webhook?.id || null,
            instantlyWebhookUrl: result.webhook?.target_hook_url || targetUrl,
            instantlyWebhookStatus: typeof result.webhook?.status === 'number' ? result.webhook.status : null,
            instantlyWebhookUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        res.json({
            clientId: result.clientId,
            webhookId: result.webhook?.id || null,
            targetUrl: result.webhook?.target_hook_url || targetUrl,
            status: result.webhook?.status ?? null,
            secret: result.secret
        });
    } catch (error) {
        console.error('Error registering Instantly webhook:', error);
        res.status(500).json({ error: 'Failed to register Instantly webhook.' });
    }
});

router.post('/clients/:id/instantly/sync', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const { idToken } = req.body || {};
        const clientSlug = req.params.id;
        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientSlug) return res.status(400).json({ error: 'Missing client id.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const agencyId = decoded.uid;

        const clientRef = firestore.collection('users').doc(agencyId).collection('clients').doc(clientSlug);
        const clientSnap = await clientRef.get();
        if (!clientSnap.exists) return res.status(404).json({ error: 'Client not found.' });

        const instantlyKey = String(clientSnap.data()?.instantly_key || '').trim();
        if (!instantlyKey) return res.status(400).json({ error: 'Client is missing Instantly API key.' });

        const result = await beginInstantlySyncRun({
            agencyId,
            clientSlug,
            instantlyKey,
            triggerSource: 'manual',
            logger: (message) => console.log(`[instantly-sync][${agencyId}/${clientSlug}] ${message}`)
        });

        res.status(result.alreadyRunning ? 200 : 202).json({
            run: result.run,
            alreadyRunning: result.alreadyRunning
        });
    } catch (error) {
        console.error('Error syncing Instantly state:', error);
        res.status(500).json({ error: 'Failed to sync Instantly state.' });
    }
});

router.get('/clients/:id/instantly/sync-runs/latest', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientSlug = req.params.id;
        if (!clientSlug) return res.status(400).json({ error: 'Missing client id.' });

        const agencyId = await verifyAgencyIdFromRequest(req);
        const run = await getLatestInstantlySyncRun({ agencyId, clientSlug });
        res.json({ run });
    } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        console.error('Error fetching latest Instantly sync run:', error);
        res.status(statusCode).json({ error: error?.message || 'Failed to fetch latest Instantly sync run.' });
    }
});

router.get('/clients/:id/instantly/sync-runs/:runId', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientSlug = req.params.id;
        const runId = Number.parseInt(req.params.runId, 10);
        if (!clientSlug) return res.status(400).json({ error: 'Missing client id.' });
        if (!Number.isInteger(runId) || runId <= 0) return res.status(400).json({ error: 'Invalid sync run id.' });

        const agencyId = await verifyAgencyIdFromRequest(req);
        const run = await getInstantlySyncRun({ agencyId, clientSlug, runId });
        if (!run) return res.status(404).json({ error: 'Sync run not found.' });
        res.json({ run });
    } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        console.error('Error fetching Instantly sync run:', error);
        res.status(statusCode).json({ error: error?.message || 'Failed to fetch Instantly sync run.' });
    }
});

router.post('/clients/:id/instantly/sync-runs/:runId/stop', async (req, res) => {
    try {
        setNoStoreHeaders(res);
        const clientSlug = req.params.id;
        const runId = Number.parseInt(req.params.runId, 10);
        if (!clientSlug) return res.status(400).json({ error: 'Missing client id.' });
        if (!Number.isInteger(runId) || runId <= 0) return res.status(400).json({ error: 'Invalid sync run id.' });

        const agencyId = await verifyAgencyIdFromRequest(req);
        const run = await requestStopInstantlySyncRun({ agencyId, clientSlug, runId });
        res.json({ run });
    } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        console.error('Error stopping Instantly sync run:', error);
        res.status(statusCode).json({ error: error?.message || 'Failed to stop Instantly sync run.' });
    }
});

router.get('/clients/:clientId/analytics/instantly-events', async (req, res) => {
    try {
        setNoStoreHeaders(res);

        const { clientId } = req.params;
        const agencyId = await verifyAgencyIdFromRequest(req);
        const sqlClientId = await getOrCreateClient(agencyId, clientId);
        const requestedPeriod = String(req.query?.period || '24h').trim().toLowerCase();
        const periodConfig = INSTANTLY_ANALYTICS_PERIODS[requestedPeriod] || INSTANTLY_ANALYTICS_PERIODS['24h'];
        const requestedEventType = String(req.query?.eventType || 'all').trim().toLowerCase();
        const eventTypeFilter = buildInstantlyEventTypeFilterClause(requestedEventType, 'cie', '$3');
        const analyticsParams = [agencyId, sqlClientId, ...eventTypeFilter.params];

        let realtimeWebsocketUrl = null;
        try {
            const wsUrl = new URL(DEFAULT_SUPABASE_URL);
            wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
            wsUrl.pathname = '/realtime/v1/websocket';
            wsUrl.search = '';
            wsUrl.searchParams.set('apikey', DEFAULT_SUPABASE_PUBLISHABLE_KEY);
            wsUrl.searchParams.set('vsn', '1.0.0');
            realtimeWebsocketUrl = wsUrl.toString();
        } catch {
            realtimeWebsocketUrl = null;
        }

        const summaryResult = await pool.query(
            `SELECT
                COUNT(*)::int AS total_events,
                COUNT(DISTINCT cie.contact_id)::int AS unique_contacts,
                COUNT(DISTINCT cie.campaign_id)::int AS unique_campaigns,
                COUNT(*) FILTER (
                    WHERE LOWER(COALESCE(cie.event_type, '')) = 'email_sent'
                )::int AS emails_sent,
                COUNT(*) FILTER (
                    WHERE LOWER(COALESCE(cie.reply_category, '')) = 'positive'
                )::int AS positive_replies,
                COUNT(*) FILTER (
                    WHERE LOWER(COALESCE(cie.event_type, '')) = 'lead_meeting_booked'
                )::int AS meetings_booked,
                COUNT(*) FILTER (
                    WHERE LOWER(COALESCE(cie.event_type, '')) IN ('reply', 'replied')
                )::int AS reply_events,
                COUNT(*) FILTER (
                    WHERE LOWER(COALESCE(cie.event_type, '')) LIKE '%bounce%'
                )::int AS bounce_events,
                MIN(cie.event_timestamp) AS first_event_at,
                MAX(cie.event_timestamp) AS last_event_at
            FROM contact_instantly_events cie
            WHERE cie.agency_id = $1
            AND cie.client_id = $2
            AND cie.event_timestamp >= ${periodConfig.eventFloorSql}${eventTypeFilter.clause}`,
            analyticsParams
        );

        const byHourResult = await pool.query(
            `SELECT
                TO_CHAR(hours.bucket, 'YYYY-MM-DD\"T\"HH24:00:00\"Z\"') AS bucket,
                ${periodConfig.bucketLabelSql} AS label,
                COALESCE(counts.count, 0)::int AS count
            FROM generate_series(
                ${periodConfig.bucketStartSql},
                ${periodConfig.bucketEndSql},
                INTERVAL '1 ${periodConfig.bucketUnit}'
            ) AS hours(bucket)
            LEFT JOIN (
                SELECT
                    ${periodConfig.bucketTruncSql} AS bucket,
                    COUNT(*)::int AS count
                FROM contact_instantly_events cie
                WHERE cie.agency_id = $1
                AND cie.client_id = $2
                AND cie.event_timestamp >= ${periodConfig.eventFloorSql}${eventTypeFilter.clause}
                GROUP BY 1
            ) counts ON counts.bucket = hours.bucket
            ORDER BY hours.bucket ASC`,
            analyticsParams
        );

        const eventTypeResult = await pool.query(
            `SELECT DISTINCT LOWER(COALESCE(cie.event_type, 'unknown')) AS event_type
            FROM contact_instantly_events cie
            WHERE cie.agency_id = $1
            AND cie.client_id = $2
            AND cie.event_timestamp >= ${periodConfig.eventFloorSql}`,
            [agencyId, sqlClientId]
        );

        const recentEventsResult = await pool.query(
            `SELECT
                cie.id::text AS id,
                LOWER(COALESCE(cie.event_type, 'unknown')) AS event_type,
                cie.reply_category,
                cie.lead_email,
                cie.email_account,
                cie.message_text,
                cie.reply_text_snippet,
                cie.event_timestamp,
                ic.name AS campaign_name
            FROM contact_instantly_events cie
            LEFT JOIN instantly_campaigns ic ON ic.id = cie.campaign_id
            WHERE cie.agency_id = $1
            AND cie.client_id = $2
            AND cie.event_timestamp >= ${periodConfig.eventFloorSql}${eventTypeFilter.clause}
            ORDER BY cie.event_timestamp DESC NULLS LAST, cie.created_at DESC NULLS LAST, cie.id DESC
            LIMIT 10`,
            analyticsParams
        );

        const availableEventTypes = [
            { value: 'all', label: formatInstantlyEventTypeLabel('all') },
            ...Array.from(
                new Map(
                    eventTypeResult.rows
                        .map((row) => normalizeInstantlyEventType(row.event_type))
                        .filter(Boolean)
                        .map((value) => [value, { value, label: formatInstantlyEventTypeLabel(value) }])
                ).values()
            )
        ];

        res.json({
            clientSqlId: sqlClientId,
            realtimeConfig: realtimeWebsocketUrl
                ? {
                    websocketUrl: realtimeWebsocketUrl,
                    supabaseUrl: DEFAULT_SUPABASE_URL,
                    publishableKey: DEFAULT_SUPABASE_PUBLISHABLE_KEY
                }
                : null,
            window: {
                period: periodConfig.period,
                label: periodConfig.label,
                bucketUnit: periodConfig.bucketUnit,
                startAt: new Date(byHourResult.rows[0]?.bucket || Date.now()).toISOString(),
                endAt: new Date(byHourResult.rows[byHourResult.rows.length - 1]?.bucket || Date.now()).toISOString()
            },
            eventType: {
                value: eventTypeFilter.normalized,
                label: formatInstantlyEventTypeLabel(eventTypeFilter.normalized)
            },
            availableEventTypes,
            summary: summaryResult.rows[0] || {
                total_events: 0,
                unique_contacts: 0,
                unique_campaigns: 0,
                emails_sent: 0,
                positive_replies: 0,
                meetings_booked: 0,
                reply_events: 0,
                bounce_events: 0,
                first_event_at: null,
                last_event_at: null
            },
            byHour: byHourResult.rows,
            recentEvents: recentEventsResult.rows
        });
    } catch (error) {
        const statusCode = Number(error?.statusCode || 500);
        console.error('Error fetching Instantly event analytics:', error);
        res.status(statusCode).json({ error: error?.message || 'Failed to fetch Instantly event analytics.' });
    }
});

// GET /api/clients/:id/campaigns/list - Fetch campaigns from SQL for dropdown
router.get('/clients/:clientId/campaigns/list', async (req, res) => {
    try {
        const { clientId } = req.params;
        const agencyId = req.query.agencyId;
        
        console.log('[campaigns/list] Request:', { clientId, agencyId });
        
        if (!agencyId) {
            return res.status(400).json({ error: 'Missing agencyId query parameter.' });
        }
        
        // Get or create SQL client_id using the Firestore client slug
        const sqlClientId = await getOrCreateClient(agencyId, clientId);
        console.log('[campaigns/list] SQL client_id:', sqlClientId);
        
        // Fetch campaigns from SQL
        const campaignsResult = await pool.query(
            `SELECT id, name, instantly_campaign_id, start_date
             FROM instantly_campaigns
             WHERE client_id = $1 AND agency_id = $2
             ORDER BY start_date DESC NULLS LAST, name ASC`,
            [sqlClientId, agencyId]
        );
        
        console.log('[campaigns/list] Found campaigns:', campaignsResult.rows.length);
        
        res.json({ campaigns: campaignsResult.rows });
    } catch (error) {
        console.error('Error fetching campaigns list:', error);
        res.status(500).json({ error: 'Failed to fetch campaigns list.' });
    }
});

// POST /api/clients/:clientId/instantly-import/merge - Merge Instantly CSV into SQL (no-delete)
router.post('/clients/:clientId/instantly-import/merge', upload.single('file'), async (req, res) => {
    try {
        const { clientId } = req.params;
        const idToken = String(req.body?.idToken || '').trim();
        const notesRaw = String(req.body?.notes || '').trim();
        const campaignNameOverridesRaw = String(req.body?.campaignNameOverrides || '').trim();
        const file = req.file;

        if (!idToken) return res.status(400).json({ error: 'Missing ID token.' });
        if (!clientId) return res.status(400).json({ error: 'Missing client id.' });
        if (!file?.buffer) return res.status(400).json({ error: 'Missing CSV file upload.' });

        const decoded = await admin.auth().verifyIdToken(idToken);
        const uid = decoded.uid;

        const clientRef = firestore.collection('users').doc(uid).collection('clients').doc(clientId);
        const clientSnap = await clientRef.get();
        if (!clientSnap.exists) return res.status(404).json({ error: 'Client not found.' });

        const instantlyKey = String(clientSnap.data()?.instantly_key || '').trim();
        if (!instantlyKey) {
            return res.status(400).json({ error: 'Client has no Instantly API key configured.' });
        }

        let rows;
        try {
            rows = csvParse(file.buffer.toString('utf8'), {
                columns: true,
                skip_empty_lines: true,
                trim: true,
                bom: true,
                relax_column_count: true,
                relax_quotes: true,
                skip_records_with_error: true
            });
        } catch (error) {
            console.error('[instantly-import/merge] CSV parse failed:', error?.message || error);
            return res.status(400).json({ error: 'Malformed CSV file.' });
        }

        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ error: 'CSV file contains no data rows.' });
        }

        const headerLookup = buildHeaderLookup(rows);
        if (!hasAnyHeaderAlias(headerLookup, CAMPAIGN_NAME_ALIASES)) {
            return res.status(400).json({ error: 'Missing required "Campaign Name" column.' });
        }

        const sqlClientId = await getOrCreateClient(uid, clientId);
        let campaignNameOverridesInput = {};
        if (campaignNameOverridesRaw) {
            try {
                const parsed = JSON.parse(campaignNameOverridesRaw);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    return res.status(400).json({ error: 'campaignNameOverrides must be a JSON object.' });
                }
                campaignNameOverridesInput = parsed;
            } catch {
                return res.status(400).json({ error: 'campaignNameOverrides must be valid JSON.' });
            }
        }

        // Fetch campaigns from Instantly API (live) and resolve duplicate names deterministically
        const instantlyResp = await fetch('https://api.instantly.ai/api/v2/campaigns', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${instantlyKey}`,
                'Accept': 'application/json'
            }
        });

        if (!instantlyResp.ok) {
            const message = await instantlyResp.text().catch(() => '');
            console.error('[instantly-import/merge] Instantly campaigns fetch failed:', instantlyResp.status, message);
            return res.status(502).json({ error: 'Failed to fetch campaigns from Instantly API.' });
        }

        const instantlyPayload = await instantlyResp.json();
        const instantlyItems = extractCampaignApiItems(instantlyPayload);
        const parsedCampaigns = instantlyItems
            .map((item) => {
                const instantlyCampaignId = String(item?.id || item?.campaignId || item?.uuid || item?._id || '').trim();
                const name = String(item?.name || item?.title || item?.campaign_name || '').trim();
                if (!instantlyCampaignId || !name) return null;
                const createdRaw = item?.timestamp_created || item?.createdAt || item?.created_at || item?.created || item?.created_at_utc || null;
                const createdAt = createdRaw ? new Date(createdRaw) : null;
                const createdAtIso = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toISOString() : null;
                return {
                    instantlyCampaignId,
                    name,
                    status: item?.status ?? item?.state ?? null,
                    startDate: createdAtIso ? new Date(createdAtIso) : null,
                    raw: item
                };
            })
            .filter(Boolean);

        if (!parsedCampaigns.length) {
            return res.status(502).json({ error: 'No campaigns were returned from Instantly API.' });
        }

        // Upsert all fetched campaigns to SQL cache
        const campaignChunks = chunkArray(parsedCampaigns, 300);
        for (const campaignChunk of campaignChunks) {
            const params = [];
            const values = [];
            let paramIndex = 1;
            for (const campaign of campaignChunk) {
                params.push(uid, sqlClientId, campaign.instantlyCampaignId, campaign.name, campaign.startDate, campaign.status ?? null, JSON.stringify(campaign.raw || {}));
                values.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}::jsonb)`);
                paramIndex += 7;
            }

            await pool.query(
                `INSERT INTO instantly_campaigns (agency_id, client_id, instantly_campaign_id, name, start_date, status, raw_campaign_payload)
                 VALUES ${values.join(', ')}
                 ON CONFLICT (agency_id, client_id, instantly_campaign_id)
                 DO UPDATE SET
                    name = EXCLUDED.name,
                    start_date = COALESCE(EXCLUDED.start_date, instantly_campaigns.start_date),
                    status = COALESCE(EXCLUDED.status, instantly_campaigns.status),
                    raw_campaign_payload = EXCLUDED.raw_campaign_payload,
                    last_synced_at = now(),
                    created_at = COALESCE(instantly_campaigns.created_at, now())`,
                params
            );
        }

        const campaignsByNormalizedName = new Map();
        parsedCampaigns.forEach((campaign) => {
            const normalizedName = normalizeCampaignName(campaign.name);
            if (!normalizedName) return;
            const existing = campaignsByNormalizedName.get(normalizedName) || [];
            existing.push(campaign);
            campaignsByNormalizedName.set(normalizedName, existing);
        });

        const resolvedCampaignByNormalizedName = new Map();
        const duplicateNameResolutionByNormalizedName = new Map();
        for (const [normalizedName, candidates] of campaignsByNormalizedName.entries()) {
            const resolution = choosePreferredCampaign(candidates.map((candidate) => ({
                id: candidate.instantlyCampaignId,
                status: candidate.status,
                createdAt: candidate.startDate
            })));
            if (!resolution.selected) continue;
            const selectedCampaign = candidates.find((candidate) => candidate.instantlyCampaignId === String(resolution.selected.id));
            if (!selectedCampaign) continue;
            resolvedCampaignByNormalizedName.set(normalizedName, {
                campaign: selectedCampaign,
                resolutionReason: resolution.resolutionReason
            });
            if (candidates.length > 1) {
                duplicateNameResolutionByNormalizedName.set(normalizedName, resolution.resolutionReason);
            }
        }

        const resolvedInstantlyCampaignIds = Array.from(
            new Set(Array.from(resolvedCampaignByNormalizedName.values()).map((entry) => entry.campaign.instantlyCampaignId))
        );
        const sqlCampaignIdByInstantlyId = new Map();
        if (resolvedInstantlyCampaignIds.length > 0) {
            const sqlCampaignResult = await pool.query(
                `SELECT id, instantly_campaign_id
                 FROM instantly_campaigns
                 WHERE agency_id = $1
                 AND client_id = $2
                 AND instantly_campaign_id = ANY($3::text[])`,
                [uid, sqlClientId, resolvedInstantlyCampaignIds]
            );
            sqlCampaignResult.rows.forEach((row) => {
                sqlCampaignIdByInstantlyId.set(String(row.instantly_campaign_id), Number(row.id));
            });
        }

        const manualOverridePairs = Object.entries(campaignNameOverridesInput || {})
            .map(([campaignName, campaignId]) => ({
                normalizedCampaignName: normalizeCampaignName(campaignName),
                sqlCampaignId: Number(campaignId)
            }))
            .filter((item) => item.normalizedCampaignName && Number.isInteger(item.sqlCampaignId) && item.sqlCampaignId > 0);

        const manualOverrideCampaignByNormalizedName = new Map();
        if (manualOverridePairs.length > 0) {
            const manualOverrideIds = Array.from(new Set(manualOverridePairs.map((item) => item.sqlCampaignId)));
            const manualOverrideResult = await pool.query(
                `SELECT id, instantly_campaign_id, name
                 FROM instantly_campaigns
                 WHERE agency_id = $1
                 AND client_id = $2
                 AND id = ANY($3::bigint[])`,
                [uid, sqlClientId, manualOverrideIds]
            );
            const campaignById = new Map();
            manualOverrideResult.rows.forEach((row) => {
                campaignById.set(Number(row.id), {
                    sqlCampaignId: Number(row.id),
                    instantlyCampaignId: String(row.instantly_campaign_id || ''),
                    name: String(row.name || '')
                });
            });

            manualOverridePairs.forEach((item) => {
                const campaign = campaignById.get(item.sqlCampaignId);
                if (!campaign) return;
                manualOverrideCampaignByNormalizedName.set(item.normalizedCampaignName, campaign);
            });
        }

        const uniqueCsvEmails = new Set();
        const uniqueCsvDomains = new Set();
        const campaignNameByNormalizedNameFromCsv = new Map();

        rows.forEach((row) => {
            const campaignName = getCsvValueByAliases(row, CAMPAIGN_NAME_ALIASES, headerLookup);
            const normalizedCampaign = normalizeCampaignName(campaignName);
            if (normalizedCampaign && !campaignNameByNormalizedNameFromCsv.has(normalizedCampaign)) {
                campaignNameByNormalizedNameFromCsv.set(normalizedCampaign, campaignName);
            }

            const email = normalizeEmailForMatch(getCsvValueByAliases(row, EMAIL_ALIASES, headerLookup));
            if (email) uniqueCsvEmails.add(email);

            const domain = normalizeDomainForMatch(getCsvValueByAliases(row, DOMAIN_ALIASES, headerLookup));
            if (domain) uniqueCsvDomains.add(domain);
        });

        const contactByEmail = new Map();
        if (uniqueCsvEmails.size > 0) {
            const emailMatches = await pool.query(
                `SELECT c.id, c.email, c.email_status, c.full_name, co.domain_normalized
                 FROM contacts c
                 JOIN companies co ON co.id = c.company_id
                 WHERE c.client_id = $1 AND lower(c.email) = ANY($2::text[])`,
                [sqlClientId, Array.from(uniqueCsvEmails)]
            );
            emailMatches.rows.forEach((row) => {
                const key = normalizeEmailForMatch(row.email);
                if (!key || contactByEmail.has(key)) return;
                contactByEmail.set(key, {
                    id: Number(row.id),
                    email: row.email,
                    emailStatus: row.email_status,
                    fullName: row.full_name,
                    domain: row.domain_normalized
                });
            });
        }

        const contactsByDomain = new Map();
        if (uniqueCsvDomains.size > 0) {
            const domainMatches = await pool.query(
                `SELECT c.id, c.email, c.email_status, c.full_name, co.domain_normalized
                 FROM contacts c
                 JOIN companies co ON co.id = c.company_id
                 WHERE c.client_id = $1 AND co.domain_normalized = ANY($2::text[])
                 ORDER BY co.domain_normalized ASC, c.updated_at DESC`,
                [sqlClientId, Array.from(uniqueCsvDomains)]
            );

            domainMatches.rows.forEach((row) => {
                const domainKey = normalizeDomainForMatch(row.domain_normalized);
                if (!domainKey) return;
                const existing = contactsByDomain.get(domainKey) || [];
                existing.push({
                    id: Number(row.id),
                    email: row.email,
                    emailStatus: row.email_status,
                    fullName: row.full_name,
                    domain: row.domain_normalized
                });
                contactsByDomain.set(domainKey, existing);
            });
        }

        const unresolvedCampaignNames = new Set();
        const skippedRows = [];
        const linkPairs = new Map();
        const pendingEmailStatusUpdates = new Map();
        let rowsMatched = 0;
        let contactsNotFound = 0;

        rows.forEach((row, index) => {
            const rowNumber = index + 2;
            const campaignName = getCsvValueByAliases(row, CAMPAIGN_NAME_ALIASES, headerLookup);
            const normalizedCampaignName = normalizeCampaignName(campaignName);
            if (!normalizedCampaignName) {
                skippedRows.push({ row: rowNumber, reason: 'missing_campaign_name' });
                return;
            }

            const resolvedCampaign = resolvedCampaignByNormalizedName.get(normalizedCampaignName);
            const manualOverrideCampaign = manualOverrideCampaignByNormalizedName.get(normalizedCampaignName);
            if (!resolvedCampaign && !manualOverrideCampaign) {
                unresolvedCampaignNames.add(campaignName || normalizedCampaignName);
                skippedRows.push({ row: rowNumber, reason: 'campaign_name_not_found_in_instantly', campaignName });
                return;
            }

            const sqlCampaignId = manualOverrideCampaign
                ? manualOverrideCampaign.sqlCampaignId
                : sqlCampaignIdByInstantlyId.get(resolvedCampaign.campaign.instantlyCampaignId);
            if (!sqlCampaignId) {
                unresolvedCampaignNames.add(campaignName || normalizedCampaignName);
                skippedRows.push({ row: rowNumber, reason: 'campaign_name_not_found_in_sql_cache', campaignName });
                return;
            }

            const email = normalizeEmailForMatch(getCsvValueByAliases(row, EMAIL_ALIASES, headerLookup));
            const domain = normalizeDomainForMatch(getCsvValueByAliases(row, DOMAIN_ALIASES, headerLookup));
            const normalizedName = normalizePersonName(extractContactNameFromRow(row, headerLookup));
            let matchedContact = email ? contactByEmail.get(email) : null;

            if (!matchedContact && domain) {
                const domainCandidates = contactsByDomain.get(domain) || [];
                if (domainCandidates.length === 1) {
                    matchedContact = domainCandidates[0];
                } else if (domainCandidates.length > 1 && normalizedName) {
                    const nameMatches = domainCandidates.filter((candidate) => normalizePersonName(candidate.fullName) === normalizedName);
                    if (nameMatches.length === 1) {
                        matchedContact = nameMatches[0];
                    } else if (nameMatches.length > 1) {
                        contactsNotFound += 1;
                        skippedRows.push({
                            row: rowNumber,
                            reason: 'contact_ambiguous_domain_plus_name',
                            domain
                        });
                        return;
                    }
                } else if (domainCandidates.length > 1) {
                    contactsNotFound += 1;
                    skippedRows.push({
                        row: rowNumber,
                        reason: 'contact_ambiguous_domain_requires_name',
                        domain
                    });
                    return;
                }
            }

            if (!matchedContact) {
                contactsNotFound += 1;
                skippedRows.push({
                    row: rowNumber,
                    reason: 'contact_not_found',
                    email: email || null,
                    domain: domain || null
                });
                return;
            }

            rowsMatched += 1;
            const incomingEmailStatus = mapCsvEmailStatus(getCsvValueByAliases(row, EMAIL_STATUS_ALIASES, headerLookup));
            if (shouldBackfillEmailStatus(matchedContact.emailStatus, incomingEmailStatus)) {
                pendingEmailStatusUpdates.set(matchedContact.id, incomingEmailStatus);
                matchedContact.emailStatus = incomingEmailStatus;
            }

            const pairKey = `${matchedContact.id}::${sqlCampaignId}`;
            if (!linkPairs.has(pairKey)) {
                linkPairs.set(pairKey, {
                    contactId: matchedContact.id,
                    campaignId: sqlCampaignId
                });
            } else {
                skippedRows.push({
                    row: rowNumber,
                    reason: 'duplicate_contact_campaign_in_file',
                    campaignName,
                    email: email || null
                });
            }
        });

        // Conservative merge update: only fill email_status when existing status is empty/unknown
        if (pendingEmailStatusUpdates.size > 0) {
            const updates = Array.from(pendingEmailStatusUpdates.entries());
            const maxUpdatesPerChunk = Math.max(1, Math.floor((MAX_BIND_PARAMS_PER_QUERY - 1) / 2));
            const updateChunks = chunkArray(updates, maxUpdatesPerChunk);

            for (const updateChunk of updateChunks) {
                const ids = updateChunk.map(([id]) => id);
                const params = [];
                const cases = [];
                updateChunk.forEach(([id, status], index) => {
                    const idParam = index * 2 + 1;
                    const statusParam = index * 2 + 2;
                    params.push(id, status);
                    cases.push(`WHEN $${idParam} THEN $${statusParam}`);
                });
                params.push(ids);

                await pool.query(
                    `UPDATE contacts
                     SET email_status = CASE id ${cases.join(' ')} ELSE email_status END,
                         updated_at = now()
                     WHERE id = ANY($${params.length}::bigint[])`,
                    params
                );
            }
        }

        let linksInserted = 0;
        const linkRows = Array.from(linkPairs.values());
        if (linkRows.length > 0) {
            const importJobId = `manual_csv_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const notes = notesRaw || null;
            const maxLinksPerChunk = Math.max(1, Math.floor(MAX_BIND_PARAMS_PER_QUERY / 6));
            const linkChunks = chunkArray(linkRows, maxLinksPerChunk);

            for (const linkChunk of linkChunks) {
                const params = [];
                const values = [];
                let paramIndex = 1;

                linkChunk.forEach((row) => {
                    params.push(row.contactId, row.campaignId, 'manual', uid, importJobId, notes);
                    values.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5})`);
                    paramIndex += 6;
                });

                const insertResult = await pool.query(
                    `INSERT INTO contact_instantly_campaigns
                        (contact_id, campaign_id, upload_source, uploaded_by, job_id, notes)
                     VALUES ${values.join(', ')}
                     ON CONFLICT (contact_id, campaign_id) DO NOTHING
                     RETURNING contact_id, campaign_id`,
                    params
                );
                linksInserted += insertResult.rowCount || 0;
            }
        }

        const resolvedCampaigns = Array.from(campaignNameByNormalizedNameFromCsv.entries())
            .map(([normalizedName, originalName]) => {
                const manualOverrideCampaign = manualOverrideCampaignByNormalizedName.get(normalizedName);
                if (manualOverrideCampaign) {
                    return {
                        campaignName: originalName,
                        instantlyCampaignId: manualOverrideCampaign.instantlyCampaignId,
                        sqlCampaignId: manualOverrideCampaign.sqlCampaignId,
                        resolutionReason: 'manual_override'
                    };
                }
                const resolvedCampaign = resolvedCampaignByNormalizedName.get(normalizedName);
                if (!resolvedCampaign) return null;
                const sqlCampaignId = sqlCampaignIdByInstantlyId.get(resolvedCampaign.campaign.instantlyCampaignId);
                if (!sqlCampaignId) return null;
                return {
                    campaignName: originalName,
                    instantlyCampaignId: resolvedCampaign.campaign.instantlyCampaignId,
                    sqlCampaignId,
                    resolutionReason: duplicateNameResolutionByNormalizedName.get(normalizedName) || 'single_match'
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.campaignName.localeCompare(b.campaignName));

        res.json({
            summary: {
                rowsTotal: rows.length,
                rowsMatched,
                linksInserted,
                linksAlreadyPresent: Math.max(linkRows.length - linksInserted, 0),
                contactsNotFound,
                campaignNamesUnresolved: unresolvedCampaignNames.size
            },
            unresolvedCampaignNames: Array.from(unresolvedCampaignNames).sort((a, b) => a.localeCompare(b)),
            skippedRows,
            resolvedCampaigns
        });
    } catch (error) {
        console.error('Error merging Instantly CSV import:', error);
        res.status(500).json({ error: 'Failed to process Instantly CSV merge import.' });
    }
});

export default router;
