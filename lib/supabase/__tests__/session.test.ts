import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { accessTokenNeedsRefresh } from "../accessToken.ts";

describe("accessTokenNeedsRefresh", () => {
    it("refreshes when expiry is missing", () => {
        assert.equal(accessTokenNeedsRefresh(undefined, 1_000_000), true);
    });

    it("keeps a token with more than 15s remaining", () => {
        const nowMs = 1_000_000;
        const expiresAt = Math.floor((nowMs + 60_000) / 1000);
        assert.equal(accessTokenNeedsRefresh(expiresAt, nowMs), false);
    });

    it("refreshes inside the 15s skew window", () => {
        const nowMs = 1_000_000;
        const expiresAt = Math.floor((nowMs + 10_000) / 1000);
        assert.equal(accessTokenNeedsRefresh(expiresAt, nowMs), true);
    });

    it("refreshes an already-expired token", () => {
        const nowMs = 1_000_000;
        const expiresAt = Math.floor((nowMs - 1_000) / 1000);
        assert.equal(accessTokenNeedsRefresh(expiresAt, nowMs), true);
    });
});
