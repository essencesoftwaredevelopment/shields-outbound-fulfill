import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    LEAD_FILTER_CATEGORY_ACTIVITY,
    LEAD_FILTER_CATEGORY_PROPERTY,
    activityEventSelectGroups,
    leadFilterCategory,
    propertyLeadFilterFields,
    singleListIdFromLeadFilters
} from "../filterFieldGroups.ts";

describe("lead filter categories", () => {
    it("treats the activity field as the done-or-not-done category", () => {
        assert.equal(leadFilterCategory({ key: "lead_activity", type: "activity" }), LEAD_FILTER_CATEGORY_ACTIVITY);
        assert.equal(leadFilterCategory({ key: "full_name", type: "text" }), LEAD_FILTER_CATEGORY_PROPERTY);
    });

    it("hides enrichment fields from the property picker", () => {
        const fields = propertyLeadFilterFields([
            { key: "lead_activity", label: "Activity", type: "activity", group: "activity" },
            { key: "email_find_state", label: "Email Discovery", group: "activity" },
            { key: "full_name", label: "Founder Name", group: "property" }
        ]);
        assert.deepEqual(fields.map((field) => field.key), ["full_name"]);
    });

    it("groups Instantly and Shields activity values separately", () => {
        const groups = activityEventSelectGroups([
            { value: "email_sent", label: "Email Sent", source: "instantly" },
            { value: "email_found", label: "Email found", source: "shields" }
        ]);
        assert.deepEqual(groups.map((group) => group.label), ["Instantly", "Shields Outbound"]);
        assert.deepEqual(groups[0].options.map((option) => option.value), ["email_sent"]);
        assert.deepEqual(groups[1].options.map((option) => option.value), ["email_found"]);
    });

    it("derives a single list id from an applied list property filter", () => {
        assert.equal(singleListIdFromLeadFilters([{ field: "list", op: "eq", value: "42" }]), "42");
        assert.equal(
            singleListIdFromLeadFilters([{ field: "list", op: "in", value: JSON.stringify(["7"]) }]),
            "7"
        );
        assert.equal(
            singleListIdFromLeadFilters([{ field: "list", op: "in", value: JSON.stringify(["7", "8"]) }]),
            ""
        );
        assert.equal(singleListIdFromLeadFilters([{ field: "email", op: "eq", value: "a@b.com" }]), "");
    });
});
