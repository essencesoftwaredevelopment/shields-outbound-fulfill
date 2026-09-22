/**
 * All Leads filter field categories.
 *
 * Activity is anything that happened to the lead — Instantly events,
 * Shields Outbound enrichment (founder/email find, verify, shopping audit),
 * and campaign / reply / discovery-call history.
 *
 * Properties are facts about the person or company (name, email, domain,
 * revenue, current Instantly status, list membership).
 */

export const LEAD_FILTER_GROUP_ACTIVITY = 'activity';
export const LEAD_FILTER_GROUP_PROPERTY = 'property';

export const LEAD_FILTER_GROUP_LABELS = {
    [LEAD_FILTER_GROUP_ACTIVITY]: 'What someone has done (or not done)',
    [LEAD_FILTER_GROUP_PROPERTY]: 'Properties about someone'
};

export const LEAD_FILTER_GROUP_ORDER = [
    LEAD_FILTER_GROUP_ACTIVITY,
    LEAD_FILTER_GROUP_PROPERTY
];

/** Pipeline / Instantly actions — not profile attributes. */
export const LEAD_FILTER_ACTIVITY_FIELD_KEYS = [
    'lead_activity',
    'founder_find_state',
    'email_find_state',
    'email_find_completed_at',
    'email_verify_completed_at',
    'enrow_verify_attempted_at',
    'last_contacted_at',
    'added_to_campaign_at',
    'last_reply_at',
    'has_replied',
    'discovery_call_held',
    'shopping_audit_state'
];

const ACTIVITY_KEY_SET = new Set(LEAD_FILTER_ACTIVITY_FIELD_KEYS);

export function getLeadFilterFieldGroup(fieldKey) {
    return ACTIVITY_KEY_SET.has(String(fieldKey || ''))
        ? LEAD_FILTER_GROUP_ACTIVITY
        : LEAD_FILTER_GROUP_PROPERTY;
}

export function annotateLeadFilterField(field) {
    const group = getLeadFilterFieldGroup(field?.key);
    return {
        ...field,
        group,
        groupLabel: LEAD_FILTER_GROUP_LABELS[group]
    };
}
