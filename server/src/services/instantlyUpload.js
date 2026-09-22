/**
 * Shared Instantly upload helpers: the manual "Map Columns to Instantly" upload
 * (POST /jobs/:id/upload-to-instantly) and the mid-run auto-add stage
 * (enrichment/stages/instantlyBatch.js) build and send leads the same way.
 */
import { pool } from '../config/db.js';

export const INSTANTLY_UPLOAD_BATCH_SIZE = 100;

/**
 * Map one unified job row to an Instantly v2 lead.
 *
 * @param {Record<string, unknown>} row unified row (see mapUnifiedContactRow)
 * @param {Record<string, { column?: string }>} columnMapping standard fields → row column
 * @param {Array<{ name?: string, column?: string }>} [customVariables]
 */
export function buildInstantlyLead(row, columnMapping, customVariables = []) {
    const lead = {};
    Object.entries(columnMapping || {}).forEach(([field, mapping]) => {
        if (!mapping?.column) return;
        const value = row[mapping.column] || '';
        if (field === 'email') {
            lead.email = value;
        } else if (field === 'firstName') {
            lead.first_name = value;
        } else if (field === 'lastName') {
            lead.last_name = value;
        } else if (field === 'companyName') {
            lead.company_name = value;
        } else if (field === 'website') {
            lead.website = value;
        } else if (field === 'personalization') {
            lead.personalization = value;
        } else if (field.startsWith('custom_')) {
            lead[field.replace('custom_', '')] = value;
        }
    });
    if (!lead.website) {
        lead.website = row.domain || '';
    }

    const cvPayload = {};
    for (const cv of Array.isArray(customVariables) ? customVariables : []) {
        if (!cv?.name || !cv?.column) continue;
        cvPayload[cv.name] = row[cv.column] || '';
    }
    if (Object.keys(cvPayload).length > 0) {
        lead.custom_variables = cvPayload;
    }
    return lead;
}

/** Instantly's own duplicate rules, passed straight through on every add. */
export function normalizeSkipOptions(skipOptions) {
    return {
        skip_if_in_workspace: !!skipOptions?.skip_if_in_workspace,
        skip_if_in_campaign: !!skipOptions?.skip_if_in_campaign,
        skip_if_in_list: !!skipOptions?.skip_if_in_list
    };
}

/**
 * POST one batch (≤100) to Instantly v2 leads/add. Throws on failure; a 401
 * carries code INSTANTLY_UNAUTHORIZED so callers can stop instead of retrying.
 */
export async function addLeadsToInstantlyCampaign({ instantlyKey, campaignId, leads, skipOptions }) {
    const response = await fetch('https://api.instantly.ai/api/v2/leads/add', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${instantlyKey}`
        },
        body: JSON.stringify({
            campaign_id: campaignId,
            leads,
            ...normalizeSkipOptions(skipOptions)
        })
    });
    if (!response.ok) {
        const status = response.status;
        const errorText = await response.text().catch(() => '');
        const err = new Error(`Instantly v2 API error: ${status} ${errorText}`.trim());
        err.status = status;
        if (status === 401) err.code = 'INSTANTLY_UNAUTHORIZED';
        throw err;
    }
}

/** SQL id of a synced Instantly campaign, or null when it has not been synced. */
export async function getSqlCampaignId(agencyId, instantlyCampaignId) {
    const result = await pool.query(
        'SELECT id FROM instantly_campaigns WHERE agency_id = $1 AND instantly_campaign_id = $2',
        [agencyId, instantlyCampaignId]
    );
    return result.rows[0]?.id ?? null;
}

/**
 * Record contacts as added to a campaign (contact_instantly_campaigns), which
 * drives the "Added To Campaign" filters and keeps auto-add idempotent.
 *
 * @param {{ contactIds: Array<number | string>, sqlCampaignId: number, jobId: string, uploadSource: string }} input
 * @returns {Promise<number>} rows tracked
 */
export async function trackContactsInCampaign({ contactIds, sqlCampaignId, jobId, uploadSource }) {
    const ids = [...new Set((contactIds || []).map(String))];
    if (!ids.length || !sqlCampaignId) return 0;
    await pool.query(
        `INSERT INTO contact_instantly_campaigns (contact_id, campaign_id, job_id, upload_source)
         SELECT id, $2, $3, $4 FROM unnest($1::bigint[]) AS t(id)
         ON CONFLICT (contact_id, campaign_id)
         DO UPDATE SET
            job_id = COALESCE(contact_instantly_campaigns.job_id, EXCLUDED.job_id),
            added_at = now()`,
        [ids, sqlCampaignId, jobId, uploadSource]
    );
    return ids.length;
}
