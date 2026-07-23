# Workflow composition refactor — implementation plan

**Date:** 2026-07-23
**Follows:** `shopping-audit-replay-timeout-2026-07-21.md` (incident analysis)
**Design point:** single shopping-audit job up to **50k domains**, no `REPLAY_TIMEOUT`
**Shipping:** one migration branch/PR; no interim job-size cap (agreed 2026-07-23)

---

## Agreed decisions (senior review, 2026-07-23)

| Q | Decision |
|---|---|
| A1 | Design for 50k domains/job. Batch size must be dynamically tunable (env + per-job option) — that is the knob that keeps the parent event log in budget. |
| A2 | No interim upload cap. Change ships as one migration. |
| B1 | Keep current failure policy: batch failure tolerated → pause-with-error at end; whole-wave failure → early abort. Add child retry logic, but retries must never re-call Serper/OpenAI for already-successful domains (requires Phase 2 idempotency). |
| B2 | Children report `{ status: 'ok' \| 'failed' \| 'inactive' }` through the completion-hook payload; parent does not classify via error inspection. |
| B3 | Per-domain idempotency in scope: domains with existing `ad_observations` rows for the job are skipped by the serper stage. |
| C1 | Option B: second batch list flagged `resumeStagesOnly: true`; child skips audit + founders stages entirely for those batches. |
| C2 | Auto-resume from reaper, max 2 attempts, then leave paused-with-error for a human. |
| D1 | No data fix for incident job `1784649088155-h14si9`. |
| D2 | §5.3 personalization fixes committed standalone (`e92b1c6` on prod). |

---

## Phase 1 — P0: true child runs (`start()` + completion hooks)

Goal: parent event log is O(children), not O(children × steps). At 50k domains / batch 50 → 1,000 children → ~2–3k parent events, inside the soft guidance.

### 1.1 Child (`workflows/enrichment-child.ts`)

- New entry `enrichmentChildRun(input)` where input adds `completionToken: string`.
- Body unchanged (serper → waterfall → finalizeAudit → founders → emails → verify → personalize), but the workflow **never throws to the platform**. A final step always resumes the parent hook with:
  ```ts
  { batchIndex, status: 'ok' | 'failed' | 'inactive', summary?, error?: { message, code } }
  ```
- `inactive` = `assertJobActive` rejected (paused/cancelled/etc.) — classify from the thrown error's code inside the child, per B2. Everything else non-ok is `failed`.

### 1.2 Parent (`workflows/enrichment-parent.ts`)

- Per wave: one `'use step'` spawn function that calls `start(enrichmentChildRun, ...)` from `workflow/api` for each batch in the wave (wave = `CHILD_WAVE_CONCURRENCY`, chunked spawning per the child-workflows cookbook), creating one completion hook per child and returning child `wrun_` ids for logging.
- Parent awaits the wave's hooks (`Promise.allSettled` semantics preserved via the payload statuses — hooks themselves should not reject).
- Preserved behavior (B1):
  - any `failed` child → count it, continue; at end throw first failure → `handleWorkflowFailureStep` → paused-with-error, resumable;
  - **entire wave** `failed` → abort immediately (systemic outage guard);
  - `inactive` children → stop scheduling further waves; let `handleWorkflowFailureStep` classify from DB flags as today;
  - per-wave `assertJobActiveStep` and best-effort `reconcileStagesStep` stay.
- Verify API names against `workflow@4.5.0` docs / cookbook at implementation time (`defineHook`/`createHook` + resume-from-child pattern). No hooks exist in the codebase yet — this is the first use.

### 1.3 Dynamic batch size (A1)

- `resolveBatchSize(pipelineMode, options)` precedence: `jobs.options.batchSize` (per-job override) → env (`SHOPPING_AUDIT_BATCH_SIZE` / `ENRICHMENT_BATCH_SIZE`) → defaults (25 / 100).
- Same treatment for `CHILD_WAVE_CONCURRENCY` (`jobs.options.waveConcurrency` → env → 5).
- No default changes in this PR; the knobs make tuning a config change, not a deploy.

**Success criteria:** parent run event count ≈ O(children) in the Workflow UI; a 10k+ shopping audit completes with no `REPLAY_TIMEOUT`; failure/pause/cancel/resume behavior identical to today from the job's perspective.

## Phase 2 — Idempotency + child retries (B1/B3)

- `serperShoppingStep`: pre-filter `batchDomains` against existing `ad_observations` for the job (`WHERE job_id = $1 AND domain = ANY($2)`); process only missing domains.
- `signalWaterfallStep` / `finalizeShoppingAuditStep`: same skip pattern against existing signal emissions; verify finalize is re-run-safe.
- Confirm personalization queue stamps completion so re-runs never re-call OpenAI for done rows (emails/verify already queue-drop-out idempotent).
- Then raise audit step `maxRetries` 0 → 1 (currently 0 specifically because re-runs double-charged Serper).

## Phase 3 — P1 resume correctness (C1)

- `prepareBatchPlanStep` builds **two** lists:
  1. `status = 'pending'` domains → full-pipeline batches (as today);
  2. `done` domains with remaining queue work (verify/email/personalize queues joined by domain) → batches flagged `resumeStagesOnly: true`.
- `ChildBatchInput.resumeStagesOnly` → child skips serper/waterfall/finalizeAudit/founders; runs emails/verify/personalize only.
- Scope `getVerifyQueue` / email / personalize queues by `domain = ANY($batch)` **in SQL** (kills the JS `filterToBatch` starvation from incident §5.2).
- Keep the planner's predicates aligned with `jobHasRemainingPipelineWork` (same queue definitions).
- Finalize guard: `finalizeJobSuccess` clears `jobs.error`; if `jobHasRemainingPipelineWork` is still true at finalize (and not `skipVerification`), do **not** mark completed — pause-with-error so resume/auto-resume picks it up. No more "completed at 146/2,774".

## Phase 4 — Auto-resume (C2)

- `reapStalledWorkflows`: after flipping a job to paused-with-error, if `jobHasRemainingPipelineWork` → trigger the existing resume route.
- `jobs.options.autoResumeAttempts` counter, max **2**, then stay paused for a human. Reset on successful finalize.
- Precondition: verify `guardWorkflowStart` reliably rejects a second concurrent run (the reaper previously avoided auto-retrigger due to double-run risk). Depends on Phase 3 (resume must schedule the right work first).

## Phase 5 — Observability (P2)

- Persist `vercelRunId` (`run.runId`) on `jobs.options` at start and resume; log child `wrun_` ids per wave.
- Include `jobId` in parent/child step log lines.
- (`jobs.error` clearing lands in Phase 3.)

---

## Rollout

1. Feature branch off `prod`, single PR (per A2 — ships as one).
2. Unit tests: two-list batch planner, hook-payload status classification, batch-size resolution precedence.
3. Shadow-validate per `server/PIPELINE.md` (fixture job, diff contacts + shopping_audit tables).
4. Staged live runs: ~500-domain shopping audit → check parent event count in Workflow UI → ~5k → Vulcan-scale (11k+). Watch: no `REPLAY_TIMEOUT`, verification completes or job pauses honestly, resume schedules verify-only work.
5. Tune `SHOPPING_AUDIT_BATCH_SIZE` toward 50 via env once stable (keeps 50k jobs ≈ 1,000 children).
