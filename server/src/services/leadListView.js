/**
 * All-leads table vs full-row projection for GET /api/leads.
 *
 * The table only renders founder, email, verification, lead status, domain,
 * campaign names, and lists. `view=table` skips insights / personalization /
 * campaign telemetry so list pages stay small and cheap to query.
 */

export const LEAD_LIST_TABLE_VIEW = 'table';

export function isLeadListTableView(view) {
    return String(view || '').trim().toLowerCase() === LEAD_LIST_TABLE_VIEW;
}

export function leadListNeedsWarmFollowUpConfig({ instantlyStatus, filters } = {}) {
    if (String(instantlyStatus || '').trim()) return true;
    if (!Array.isArray(filters)) return false;
    return filters.some((filter) => String(filter?.field || '').trim().toLowerCase() === 'instantly_status');
}

function mapRoleType(roleType) {
    if (typeof roleType === 'string' && roleType.startsWith('instantly:')) {
        return 'instantly_lead';
    }
    return roleType;
}

function mapLatestEvent(row) {
    if (!row.latest_event_type) return null;
    return {
        eventType: row.latest_event_type,
        replyCategory: row.latest_event_reply_category,
        messageText: row.latest_event_message_text,
        replyTextSnippet: row.latest_event_reply_text_snippet,
        eventTimestamp: row.latest_event_timestamp,
        emailAccount: row.latest_event_email_account
    };
}

function mapTableCampaigns(campaignsData) {
    if (!Array.isArray(campaignsData)) return [];
    return campaignsData.map((campaign) => ({
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        leadStatus: campaign.leadStatus,
        interestStatus: campaign.interestStatus
    }));
}

export function mapLeadListRow(row, { tableView = false } = {}) {
    const lists = Array.isArray(row.lists) ? row.lists : [];
    const campaignsData = Array.isArray(row.campaigns_data) ? row.campaigns_data : [];

    const mapped = {
        id: row.id,
        domain: row.domain_normalized,
        email: row.email,
        founderName: row.full_name,
        status: row.email_status,
        verified: row.email_status === 'valid',
        emailFindCompletedAt: row.email_find_completed_at,
        emailVerifyCompletedAt: row.email_verify_completed_at,
        founderFindCompletedAt: row.founder_find_completed_at,
        campaignsData: tableView ? mapTableCampaigns(campaignsData) : campaignsData,
        lists
    };

    if (tableView) return mapped;

    return {
        ...mapped,
        roleType: mapRoleType(row.role_type),
        confidence: row.confidence,
        lastContactedAt: row.last_contacted_at,
        firstLine: row.personalization_first_line,
        jobId: row.job_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        campaignCountAllTime: row.campaign_count_all_time,
        campaignCountActive: row.campaign_count_active,
        lastCampaignAddedAt: row.last_campaign_added_at,
        latestEvent: mapLatestEvent(row),
        insights: {
            annualRevenueText: row.annual_revenue_text,
            annualRevenueMin: row.annual_revenue_min,
            annualRevenueMax: row.annual_revenue_max,
            usesKlaviyo: row.uses_klaviyo,
            klaviyoPercent: row.klaviyo_percent,
            discoveryCallHeld: row.discovery_call_held,
            lastDiscoveryCallAt: row.last_discovery_call_at,
            source: row.insight_source,
            notes: row.insight_notes,
            attributes: row.insight_attributes || {}
        }
    };
}
