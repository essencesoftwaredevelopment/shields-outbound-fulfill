import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    LEAD_FILTER_GROUP_ACTIVITY,
    LEAD_FILTER_GROUP_PROPERTY,
    LEAD_FILTER_GROUP_LABELS,
    getLeadFilterFieldGroup,
    annotateLeadFilterField
} from '../leadFilterFieldGroups.js';

describe('lead filter field groups', () => {
    it('treats Shields Outbound enrichment as activity', () => {
        assert.equal(getLeadFilterFieldGroup('founder_find_state'), LEAD_FILTER_GROUP_ACTIVITY);
        assert.equal(getLeadFilterFieldGroup('email_find_state'), LEAD_FILTER_GROUP_ACTIVITY);
        assert.equal(getLeadFilterFieldGroup('email_find_completed_at'), LEAD_FILTER_GROUP_ACTIVITY);
        assert.equal(getLeadFilterFieldGroup('email_verify_completed_at'), LEAD_FILTER_GROUP_ACTIVITY);
        assert.equal(getLeadFilterFieldGroup('shopping_audit_state'), LEAD_FILTER_GROUP_ACTIVITY);
        assert.equal(getLeadFilterFieldGroup('lead_activity'), LEAD_FILTER_GROUP_ACTIVITY);
        assert.equal(getLeadFilterFieldGroup('discovery_call_held'), LEAD_FILTER_GROUP_ACTIVITY);
        assert.equal(getLeadFilterFieldGroup('has_replied'), LEAD_FILTER_GROUP_ACTIVITY);
    });

    it('treats profile facts as properties', () => {
        assert.equal(getLeadFilterFieldGroup('full_name'), LEAD_FILTER_GROUP_PROPERTY);
        assert.equal(getLeadFilterFieldGroup('email'), LEAD_FILTER_GROUP_PROPERTY);
        assert.equal(getLeadFilterFieldGroup('email_status'), LEAD_FILTER_GROUP_PROPERTY);
        assert.equal(getLeadFilterFieldGroup('domain'), LEAD_FILTER_GROUP_PROPERTY);
        assert.equal(getLeadFilterFieldGroup('instantly_status'), LEAD_FILTER_GROUP_PROPERTY);
        assert.equal(getLeadFilterFieldGroup('uses_klaviyo'), LEAD_FILTER_GROUP_PROPERTY);
        assert.equal(getLeadFilterFieldGroup('shopping_audit_signal'), LEAD_FILTER_GROUP_PROPERTY);
        assert.equal(getLeadFilterFieldGroup('list'), LEAD_FILTER_GROUP_PROPERTY);
    });

    it('annotates fields with the Klaviyo-style group labels', () => {
        const annotated = annotateLeadFilterField({ key: 'email_find_state', label: 'Email Discovery' });
        assert.equal(annotated.group, LEAD_FILTER_GROUP_ACTIVITY);
        assert.equal(annotated.groupLabel, LEAD_FILTER_GROUP_LABELS[LEAD_FILTER_GROUP_ACTIVITY]);
    });
});
