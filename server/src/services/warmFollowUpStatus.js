/**
 * warmFollowUpStatus.js
 *
 * Applies the client's configured Instantly interest status ("Warm Follow Up"
 * label) to a lead after an interested autoresponder reply is sent, so the
 * status operators previously set by hand in Instantly happens automatically.
 *
 * The status value is workspace-specific (clients.warm_follow_up_interest_value,
 * selected in the Warm Follow Ups UI from the workspace's lead-label list).
 * The update runs in the background after the send transaction commits: it
 * never blocks or fails a send. Skipped/failed updates are recorded as marker
 * events in contact_instantly_events so misconfiguration is visible in the
 * lead activity feed instead of silently reverting to manual labeling.
 *
 * Marker event types are intentionally distinct from the 'Warm Follow Up'
 * anchor event and absent from followUpSender's BLOCKER_EVENT_TYPES, so they
 * can never affect follow-up eligibility.
 */

import crypto from 'crypto';
import { pool } from '../config/db.js';
import { updateInstantlyLeadInterestStatus } from './instantlyState.js';

export const WARM_FOLLOW_UP_LABEL_SKIPPED_EVENT = 'warm_follow_up_label_skipped';
export const WARM_FOLLOW_UP_LABEL_FAILED_EVENT = 'warm_follow_up_label_failed';

/**
 * Normalize raw Instantly lead-label objects into picker options.
 * Tolerates missing/invalid rows and both v2 field spellings.
 */
export function normalizeLeadLabels(rawLabels) {
    if (!Array.isArray(rawLabels)) return [];
    const seen = new Set();
    const normalized = [];
    for (const raw of rawLabels) {
        const label = typeof raw?.label === 'string' ? raw.label.trim() : '';
        const value = Number(raw?.interest_status);
        if (!label || !Number.isFinite(value)) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        normalized.push({
            value,
            label,
            sentiment: typeof raw?.interest_status_label === 'string' ? raw.interest_status_label : null,
            description: typeof raw?.description === 'string' ? raw.description : null
        });
    }
    return normalized;
}

/**
 * Read the configured post-send status from a clients row.
 * Returns { interestValue, label } or null when unset.
 */
export function resolveWarmFollowUpStatusConfig(clientRow) {
    const value = clientRow?.warm_follow_up_interest_value;
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
        return null;
    }
    return {
        interestValue: Number(value),
        label: typeof clientRow?.warm_follow_up_interest_label === 'string'
            ? clientRow.warm_follow_up_interest_label
            : null
    };
}

/**
 * Insert a skipped/failed marker event (idempotent per draft).
 */
async function persistWarmFollowUpLabelOutcomeEvent(db, {
    eventType,
    reason,
    draftId,
    agencyId,
    clientId,
    contactId,
    campaignId,
    instantlyCampaignId,
    instantlyLeadId,
    leadEmail,
    interestValue = null,
    errorMessage = null
}) {
    const fingerprint = crypto
        .createHash('sha256')
        .update(`warm-follow-up-label-outcome|${draftId}`)
        .digest('hex');
    const payload = {
        event_type: eventType,
        source: 'interested_autoresponder',
        reason,
        interested_autoresponder_draft_id: draftId,
        interest_value: interestValue,
        error_message: errorMessage
    };

    await db.query(
        `INSERT INTO contact_instantly_events (
            agency_id, client_id, contact_id, campaign_id, instantly_campaign_id, instantly_lead_id,
            event_type, reply_category, lead_email, event_timestamp, fingerprint, source, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
        ON CONFLICT (source, fingerprint) DO NOTHING`,
        [
            agencyId,
            clientId,
            contactId,
            campaignId,
            instantlyCampaignId || null,
            instantlyLeadId || null,
            eventType,
            null,
            leadEmail || null,
            new Date().toISOString(),
            fingerprint,
            'interested_autoresponder',
            JSON.stringify(payload)
        ]
    );
}

/**
 * Apply the configured Instantly interest status to a lead after an
 * autoresponder send. Best-effort: errors are recorded, never thrown.
 *
 * deps ({ db, updateFn }) exists for unit tests; production callers omit it.
 */
export async function applyWarmFollowUpStatusAfterAutoresponderSend({
    draftId,
    agencyId,
    clientId,
    contactId,
    campaignId,
    instantlyCampaignId,
    instantlyLeadId,
    leadEmail,
    apiKey,
    statusConfig,
    logger = () => {}
}, deps = {}) {
    const db = deps.db || pool;
    const updateFn = deps.updateFn || updateInstantlyLeadInterestStatus;
    const markerBase = {
        draftId,
        agencyId,
        clientId,
        contactId,
        campaignId,
        instantlyCampaignId,
        instantlyLeadId,
        leadEmail
    };

    try {
        if (!statusConfig || !Number.isFinite(statusConfig.interestValue)) {
            logger(`[warm-follow-up-label] skipped draft=${draftId}: no status configured for client=${clientId}`);
            await persistWarmFollowUpLabelOutcomeEvent(db, {
                ...markerBase,
                eventType: WARM_FOLLOW_UP_LABEL_SKIPPED_EVENT,
                reason: 'not_configured'
            });
            return { applied: false, reason: 'not_configured' };
        }

        if (!instantlyCampaignId || !leadEmail || !apiKey) {
            const reason = !apiKey ? 'missing_api_key' : (!leadEmail ? 'missing_lead_email' : 'missing_campaign_id');
            logger(`[warm-follow-up-label] skipped draft=${draftId}: ${reason}`);
            await persistWarmFollowUpLabelOutcomeEvent(db, {
                ...markerBase,
                eventType: WARM_FOLLOW_UP_LABEL_SKIPPED_EVENT,
                reason,
                interestValue: statusConfig.interestValue
            });
            return { applied: false, reason };
        }

        await updateFn(apiKey, {
            campaignId: instantlyCampaignId,
            leadEmail,
            interestValue: statusConfig.interestValue
        });

        // Mirror Instantly locally so All Leads filters (label + interest_status)
        // see Warm Follow Up without waiting on a later sync.
        if (contactId && campaignId) {
            const localLabel = statusConfig.label || 'Warm Follow Up';
            await db.query(
                `UPDATE contact_instantly_campaigns
                 SET interest_status = $3,
                     interest_status_label = $4,
                     timestamp_last_interest_change = NOW(),
                     last_event_type = 'interest_status_set',
                     last_synced_at = NOW()
                 WHERE contact_id = $1
                   AND campaign_id = $2`,
                [contactId, campaignId, statusConfig.interestValue, localLabel]
            );
        }

        logger(
            `[warm-follow-up-label] applied draft=${draftId} lead=${leadEmail}`
            + ` value=${statusConfig.interestValue}${statusConfig.label ? ` (${statusConfig.label})` : ''}`
        );
        return { applied: true };
    } catch (error) {
        const message = error?.message || String(error);
        console.error(`[warm-follow-up-label] failed draft=${draftId} lead=${leadEmail}: ${message}`);
        try {
            await persistWarmFollowUpLabelOutcomeEvent(db, {
                ...markerBase,
                eventType: WARM_FOLLOW_UP_LABEL_FAILED_EVENT,
                reason: 'api_error',
                interestValue: statusConfig?.interestValue ?? null,
                errorMessage: message.slice(0, 500)
            });
        } catch (markerError) {
            console.error(`[warm-follow-up-label] marker write failed draft=${draftId}: ${markerError?.message || markerError}`);
        }
        return { applied: false, reason: 'api_error', error: message };
    }
}
