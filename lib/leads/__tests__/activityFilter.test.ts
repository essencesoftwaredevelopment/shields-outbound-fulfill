import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    activityFrequencyNeedsCount,
    defaultLeadActivityValue,
    isLeadActivityFilterComplete,
    parseLeadActivityValue,
    serializeLeadActivityValue
} from "../activityFilter.ts";

describe("lead activity filter value", () => {
    it("serializes the Klaviyo default sentence", () => {
        const value = defaultLeadActivityValue();
        assert.equal(value.eventType, "email_sent");
        assert.equal(value.timeframe.kind, "in_the_last");
        assert.equal(value.timeframe.amount, 30);
        const parsed = parseLeadActivityValue(serializeLeadActivityValue(value));
        assert.deepEqual(parsed, value);
    });

    it("treats at least once as complete without a count", () => {
        const raw = serializeLeadActivityValue(defaultLeadActivityValue("email_opened"));
        assert.equal(isLeadActivityFilterComplete("at_least_once", raw), true);
        assert.equal(activityFrequencyNeedsCount("at_least_once"), false);
    });

    it("requires a count for equals", () => {
        const raw = serializeLeadActivityValue(defaultLeadActivityValue());
        assert.equal(isLeadActivityFilterComplete("eq", raw), false);
        const withCount = serializeLeadActivityValue({
            ...defaultLeadActivityValue(),
            count: 3
        });
        assert.equal(isLeadActivityFilterComplete("eq", withCount), true);
    });

    it("keeps an incomplete campaign WHERE from applying", () => {
        const raw = serializeLeadActivityValue({
            ...defaultLeadActivityValue("added_to_campaign"),
            where: [{ dimension: "campaign", op: "eq", value: "" }]
        });
        assert.equal(isLeadActivityFilterComplete("at_least_once", raw), false);
        const complete = serializeLeadActivityValue({
            ...defaultLeadActivityValue("added_to_campaign"),
            where: [{ dimension: "campaign", op: "eq", value: "camp-1" }]
        });
        assert.equal(isLeadActivityFilterComplete("at_least_once", complete), true);
    });
});
