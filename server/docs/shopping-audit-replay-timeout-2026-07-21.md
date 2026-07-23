# Shopping audit job stall — observations & suggested changes

**Date investigated:** 2026-07-23  
**Incident job:** `1784649088155-h14si9`  
**Agency:** `efddb63d-a4c9-44d9-a204-baa052fd0fd8` (Vulcan)  
**Pipeline:** `shopping_audit` via Vercel Workflows (`executionRunner: vercel`)  
**Audience:** engineering review (senior)

---

## 1. Executive summary

A ~11.4k-domain shopping-audit job completed Serper matching, then died mid-enrichment. Email verification only finished **146 / ~2,774** matched domains. The job later showed `completed` with error:

> `Stalled — no workflow progress for 20+ minutes. Resume to continue.`

**Root cause is not TryKitt or verification.** Vercel killed the parent workflow with:

```text
errorCode: REPLAY_TIMEOUT
Workflow replay exceeded maximum duration (240s) after 7 attempts
wrun_01KY2P02K4DCCSAY2K8BXNHDXD
```

The parent uses **direct `await` of child workflows**, which **flattens** all child steps into one shared event log. At this scale that log can no longer be replayed within Vercel’s **240s** replay budget.

---

## 2. Job facts

| Field | Value |
|---|---|
| Created | 2026-07-21 **15:51:28 UTC** (18:51 local UTC+3) |
| Domains | 11,421 |
| Ad observations (Serper) | 11,421 |
| Signal emissions | 2,774 |
| Domains `done` / `skipped` | 2,774 / 8,647 |
| Contacts verified on this job | **146** |
| Personalized | 104 |
| Runner | Vercel Workflows |
| Correlation UUID on job | `options.workflowRunId` (app-generated; see §6) |
| Platform run | `wrun_01KY2P02K4DCCSAY2K8BXNHDXD` |

Upload options included: `skipFounderFinder`, `skipEmailFinder`, `skipVerification: false`, `personalizeFirstLine: true`, `dedupeStrategy: include`.

A follow-up standard job (`1784720401465-fitnmr`, next day) verified the remaining **2,628** contacts on the matched domains.

---

## 3. Timeline (UTC)

| Time | What happened |
|---|---|
| 15:51 | Job created; domain prep |
| ~15:51–18:10 | Serper shopping + signal waterfall (bulk of ad_observations / signals) |
| 16:57 onward | Flow route already logging `REPLAY_TIMEOUT` (retries) |
| 18:11–18:17 | Verification + personalization making progress (~136 verifies) |
| **~18:18–18:21** | **All progress stops** (signals, verify, personalize) |
| 18:18–18:21 | Final `REPLAY_TIMEOUT` (attempt 7); flow process exits; queue message errors |
| Later | Reap cron marks job stalled (20+ min no `updated_at` / no API activity) |
| 23:07 | Partial resume/finalize: +10 verifies, job marked `completed` (error string left on row) |

Verify completion minutes on this job’s contacts: `18:11`, `18:13`, `18:15`, `18:17`, then gap until `23:07`.

---

## 4. Root cause: flattened children → parent replay timeout

### 4.1 What the code does today

`workflows/enrichment-parent.ts` fans out batches like:

```ts
await Promise.allSettled(
  wave.map((batchDomains, waveIndex) =>
    enrichmentChildWorkflow({ jobId, agencyId, batchDomains, batchIndex, pipelineMode })
  )
);
```

`enrichmentChildWorkflow` is marked `'use workflow'`, but it is **invoked by direct await**, not via `start()` from `workflow/api`.

In the Workflow SDK:

| Composition | Effect |
|---|---|
| `await childWorkflow(...)` | **Flattened** — child steps share the **parent** event log / run |
| `start(childWorkflow, ...)` from a step (+ hooks to wait) | **Independent run** — own `wrun_`, own event log, own retry boundary |

The only `start()` in this path is in `app/internal/enrichment/start/route.ts`, which starts the **parent** once.

So today we do **not** have “lots of independent child runs.” We have **one massive parent run** whose event log contains every batch’s steps (serper → waterfall → finalize → founders → emails → verify → personalize).

### 4.2 Why that fails at shopping-audit scale

Defaults (`lib/enrichment/types.ts`):

- `SHOPPING_AUDIT_BATCH_SIZE` = **25**
- `CHILD_WAVE_CONCURRENCY` = **5**

For 11,421 domains ≈ **457** batches ≈ **92** waves. Each child path is ~**7** durable steps.

Vercel limits / guidance ([Workflow pricing & limits](https://vercel.com/docs/workflows/pricing)):

| Limit | Value |
|---|---|
| Events per run (hard) | 25,000 |
| Steps per run (hard) | 10,000 |
| Max workflow **replay** duration | **240s** |
| Soft guidance | &gt; **~2,000 events** → slower replay; prefer child workflows as separate pieces |

Exported runtime logs (fulfill log, 2026-07-21) show **943** entries, all on `/.well-known/workflow/v1/flow`, mostly HTTP 500, with repeated:

```text
[Workflow] Workflow replay exceeded timeout {
  workflowRunId: 'wrun_01KY2P02K4DCCSAY2K8BXNHDXD',
  timeoutMs: 240000,
  attempt: N,
  maxRetries: 3
}
```

Final failure surface in the Workflow UI:

```text
errorCode: REPLAY_TIMEOUT
Workflow replay exceeded maximum duration (240s) after 7 attempts
```

That matches the product cliff: parent must re-walk a huge event log to schedule the next wave; replay exceeds 240s; run dies; in-workflow `handleWorkflowFailure` never runs; job stays `running` until `/internal/enrichment/reap` recovers it.

### 4.3 What this is *not*

- Not TryKitt credit exhaustion (no credit error; verifies were succeeding until the cut).
- Not “verification stage hung.” Serper signals and personalization stopped in the same minute.
- Not “batch size alone,” though size 25 multiplies step/event count (see §5).

---

## 5. Secondary issues observed

### 5.1 Incomplete verification left as “completed”

After the stall, founders had already marked many matched domains `done`. On resume, the parent re-plans from `listPendingDomainNames` (`status = 'pending'` only). Domains that are `done` but never verified are **not** re-queued. Finalize then marks stages completed (`deriveStageStatus(..., { finalize: true })` forces `completed`).

Result: verification summary looked like **146 / 11,418 eligible** but status `completed`.

### 5.2 Parallel verify queue starvation (latent)

`getVerifyQueue` is global (ordered by `contact id`, `LIMIT batchSize+500`), then `filterToBatch` keeps the current batch. Under parallel waves, batches can see an empty local queue while work remains for other domains. Combined with §5.1, unfinished verify is easy to strand.

### 5.3 Personalization forced on for shopping audit

UI previously sent `personalizeFirstLine: true` whenever `pipelineMode === 'shopping_audit'`. Product ask: **shopping audit should not run personalization.**

**Already changed in this investigation branch:**

- UI: force `false` for shopping audit uploads.
- API (`server/src/routes/jobs.js`): force `personalizeFirstLine = false` when `pipelineMode === 'shopping_audit'`.

### 5.4 Platform run id not persisted

Start route returns both:

- `workflowRunId` — app `randomUUID()` (stored on job)
- `vercelRunId` — `run.runId` / `wrun_…` (**not** stored)

Debugging required searching the Workflow UI / log export by time. Recommend persisting `vercelRunId` on `jobs.options`.

### 5.5 Stall error left on successful finalize

`finalizeJobSuccess` sets `status = 'completed'` but does not clear `jobs.error`, so the row can show completed **and** the stall message.

---

## 6. What Vercel recommends for this shape of pipeline

Official guidance for large fan-out:

1. Prefer **child workflows as separate runs** when event volume grows (especially past ~2k events).
2. Spawn with **`start()` from a step**; wait with **completion hooks** (`startAndWait` pattern) — not flattened `await child()`.
3. Chunk spawning (**10–50** children at a time); don’t fire hundreds of `start()` calls in one step.
4. Keep the parent event log small (spawn + hook resumes + light bookkeeping).
5. Do **not** treat “100+ parent runs” as the primary design — one orchestrator + many independent children is the documented pattern.

References:

- [Workflow pricing & limits](https://vercel.com/docs/workflows/pricing) (2k-event soft guidance, 240s replay)
- [Child workflows cookbook](https://workflow-sdk.dev/cookbook/advanced/child-workflows) (`start` + hooks, chunked fan-out)

---

## 7. Suggested changes (priority order)

### P0 — Fix composition (addresses `REPLAY_TIMEOUT`)

Refactor `enrichment-parent.ts` so each batch is a **true** child run:

1. From a `'use step'`, call `start(enrichmentChildWithCompletion, [batchInput, hookToken])`.
2. Parent awaits a **completion hook** (SDK `defineHook` / `startAndWait` pattern).
3. Keep wave concurrency in the 5–50 range (current 5 is fine; can tune up once stable).
4. Ensure child `finally` resumes the parent hook with `{ status, value | error }` so partial failures don’t kill siblings (`Promise.allSettled` at parent).

**Success criteria:** parent `wrun_` event count stays roughly O(batches) for spawn/complete, not O(batches × steps). A 10k-domain shopping job should not hit `REPLAY_TIMEOUT`.

### P1 — Resume / verify correctness

1. On resume / batch plan: include domains that are `done` but still have verify (or email / personalize) queue work — not only `pending` `job_domains`.
2. Align `jobHasRemainingPipelineWork` with what the parent actually schedules (already checks verify queue; planning must too).
3. Scope `getVerifyQueue` (and email/personalize queues) by **batch domain list in SQL**, or raise limits and partition so parallel waves don’t starve.
4. Clear `jobs.error` on successful finalize; optionally refuse to mark verification `completed` when eligible unverified contacts remain (unless `skipVerification`).

### P2 — Observability

1. Persist `vercelRunId` (`run.runId`) on `jobs.options` at start (and on resume).
2. Log `jobId` in flow/step messages where possible for log search.
3. Surface `REPLAY_TIMEOUT` / workflow failure disposition into `jobs.error` when the platform fails the run (if/when the failure handler can observe it).

### P3 — Tuning (helps, does not replace P0)

| Knob | Today | Suggestion |
|---|---|---|
| `SHOPPING_AUDIT_BATCH_SIZE` | 25 | Try **50–75** after P0; watch step `maxDuration` on Serper/waterfall |
| `CHILD_WAVE_CONCURRENCY` | 5 | Can raise modestly once children are independent runs |
| `WORKFLOW_REPLAY_TIMEOUT_MS` | 240s default | **Band-aid only**; do not rely on this instead of P0 |
| Split into many parent runs | — | **Not recommended** as primary design |

### P4 — Product (done / confirm)

- Shopping audit: **no** personalization stage (UI + API forced off). Confirm no other entry points re-enable it.

---

## 8. What we should *not* do

- **Don’t** split one logical job into 100+ parent runs as the main fix — coordination, resume, and finalize become worse; Vercel’s answer is independent **child** runs under one parent.
- **Don’t** only increase batch size and call it fixed — flattened await will still accumulate events; size only delays the cliff.
- **Don’t** treat the stall reaper as the failure handler — it’s a backstop after the platform already lost the run.

---

## 9. Open questions for senior review

1. Adopt full `start()` + hooks now, or interim raise `WORKFLOW_REPLAY_TIMEOUT_MS` + larger batches while P0 is built?
2. Target max domains per single shopping-audit job until P0 ships?
3. Should resume auto-retrigger when `jobHasRemainingPipelineWork` is true after reap, or keep manual resume?
4. PM2 runner as fallback for very large shopping audits until Workflow composition is fixed?

---

## 10. Appendix — key file pointers

| Area | Path |
|---|---|
| Parent orchestrator | `workflows/enrichment-parent.ts` |
| Child batch | `workflows/enrichment-child.ts` |
| Batch size / concurrency | `lib/enrichment/types.ts`, `lib/enrichment/batchPlan.ts` |
| Workflow trigger | `app/internal/enrichment/start/route.ts` |
| Stall watchdog | `server/src/enrichment/reapStalledWorkflows.js`, `app/internal/enrichment/reap/route.ts` |
| Verify batch | `server/src/enrichment/stages/verificationBatch.js` |
| Pending domain plan | `server/src/enrichment/domainPrep.js` → `listPendingDomainNames` |
| Finalize / failure | `server/src/enrichment/finalize.js`, `persist.js` |
| Log export used | `shields-outbound-fulfill-log-export-2026-07-23T12-04-46.json` (local Downloads) |

---

## 11. One-line takeaway

**We thought we had child workflows; we actually have one giant flattened parent. At 11k shopping-audit domains it hit Vercel’s 240s replay limit (`REPLAY_TIMEOUT`), which is why verification looked like it “stalled.” Fix composition with `start()` + hooks; then harden resume/verify and observability.**
