import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isCreditExhaustedJob,
  isCreditExhaustionText,
  shouldShowCreditExhaustionNotice,
} from "../creditExhaustion.ts";

describe("isCreditExhaustionText", () => {
  it("matches the Vercel workflow pause message", () => {
    assert.equal(
      isCreditExhaustionText(
        'Step "step//./workflows/enrichment-child//emailsStep" failed after 2 retries: TryKitt is out of credits — add credits and resume the job to finish email discovery.'
      ),
      true
    );
  });

  it("matches the PM2 stage error", () => {
    assert.equal(isCreditExhaustionText("Add Credits to TryKitt"), true);
  });

  it("ignores unrelated errors", () => {
    assert.equal(isCreditExhaustionText("Job paused"), false);
    assert.equal(isCreditExhaustionText("TryKitt throttled or timed out"), false);
    assert.equal(isCreditExhaustionText(null), false);
  });
});

describe("shouldShowCreditExhaustionNotice", () => {
  it("shows for a paused job with the credits error", () => {
    assert.equal(
      shouldShowCreditExhaustionNotice({
        paused: true,
        status: "running",
        error: "TryKitt is out of credits — add credits and resume the job to finish email discovery.",
      }),
      true
    );
  });

  it("shows when only a stage error is set (PM2 path)", () => {
    assert.equal(
      shouldShowCreditExhaustionNotice({
        paused: true,
        status: "running",
        error: null,
        stages: { emailDiscovery: { error: "Add Credits to TryKitt" } },
      }),
      true
    );
  });

  it("hides after resume or terminal status", () => {
    assert.equal(
      shouldShowCreditExhaustionNotice({
        paused: false,
        status: "running",
        error: "TryKitt is out of credits — add credits and resume the job.",
      }),
      false
    );
    assert.equal(
      shouldShowCreditExhaustionNotice({
        paused: true,
        status: "failed",
        error: "TryKitt is out of credits — add credits and resume the job.",
      }),
      false
    );
  });
});

describe("isCreditExhaustedJob", () => {
  it("reads activityMessage when error is empty", () => {
    assert.equal(
      isCreditExhaustedJob({
        activityMessage: "TryKitt is out of credits — add credits and resume the job.",
      }),
      true
    );
  });
});
