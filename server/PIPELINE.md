# Shields Outbound Pipeline (Server)

This document explains the server-side job pipeline end-to-end. It is scoped to the Node/Express server under server/ and focuses on how a CSV upload becomes validated, enriched, and persisted leads.

## Overview

The pipeline is orchestrated by the Jobs API and implemented primarily in:

- server/src/routes/jobs.js
- server/src/services/jobPipeline.js
- server/src/services/leads.js
- server/src/lib/db.js
- server/src/utils/csv.js

High-level flow:

1) CSV upload and job creation
2) Domain prep (normalize, dedupe, DNS)
3) Founders discovery (optional)
4) Email discovery (optional)
5) Email verification (optional)
6) Personalization (optional)
7) Unified output CSVs and SQL upserts
8) Upload to Instantly (optional)

All SQL operations are scoped to the authenticated agency_id (Firebase uid). The Firestore users/{uid} document ID is the canonical agency identifier and is used directly in Cloud SQL.

## Auth and Tenant Boundaries

- Firebase ID tokens are verified server-side.
- The uid from the token is the canonical agency_id.
- The frontend never sends agency_id; it is derived from the token.
- All SQL queries are scoped by agency_id and client_id where applicable.

Key files:

- server/src/middleware/auth.js
- server/src/services/db/queries.js
- server/src/lib/db.js

## Execution model (PM2 queue + Vercel Workflows)

Enrichment jobs can run on **PM2** (default) or **Vercel Workflows** (opt-in). Instantly sync, follow-ups, and webhooks always stay on PM2.

A second, independent Workflows use exists on the reply path: the **interested-reply
research workflow** (see "Interested-reply research workflow" below). It shares the
Workflows runtime and trigger pattern with enrichment but nothing else — it is
per-event and human-gated, never part of the enrichment parent/child fan-out.

| Runner | Trigger | Worker |
|--------|---------|--------|
| `pm2` (default) | `POST /api/jobs` → `job_queue` | `src/worker/queueWorker.js` → `runJobChild.js` |
| `vercel` | `POST /api/jobs` → `POST /internal/enrichment/start` | `workflows/enrichment-parent.ts` → child batches |

**Routing:** `executionRunner` is resolved from (in order) job `options.executionRunner`, env `ENRICHMENT_RUNNER=vercel`, or agency feature `features.enrichmentRunner: 'vercel'`. See `server/src/enrichment/executionRunner.js`.

**Parallel period:** PM2 worker skips Vercel jobs (`claimNextQueuedJob` filters `executionRunner != 'vercel'`). Workflow start refuses double-run when `jobs.status = running` and `workflowRunId` is set.

**Vercel path layout:**
- `server/src/enrichment/` — shared context, hydrate, stage batch runners, rate limits
- `workflows/enrichment-parent.ts` — domain prep → wave fan-out of independent child runs
  (`start()` from a step + one completion hook per child; batch size 25 shopping / 100 standard,
  wave 5 — each tunable via `jobs.options.batchSize` / `.waveConcurrency`, then env
  `SHOPPING_AUDIT_BATCH_SIZE` / `ENRICHMENT_BATCH_SIZE` / `ENRICHMENT_CHILD_WAVE_CONCURRENCY`) → finalize
- `workflows/enrichment-child.ts` — shopping audit (if applicable) → founders → emails → verify →
  personalization, then a final step reports `{ status: 'ok' | 'failed' | 'inactive' }` to the
  parent's completion hook — pipeline errors never fail the child run to the platform. Batches
  flagged `resumeStagesOnly` (domains past 'pending' whose contacts still hold queue work) skip
  the audit + founders stages and run emails → verify → personalize only.
- `app/internal/enrichment/start/route.ts` — secured trigger (`WORKFLOW_TRIGGER_SECRET`)
- `app/internal/enrichment/reap/route.ts` — stalled-job watchdog, hit by Vercel Cron (`vercel.json`)

**Failure handling (Vercel runner):** The parent/child workflows are wrapped in a top-level
catch → `handleWorkflowFailure` (`finalize.js`). Any throw resolves the job to a recoverable
terminal state — **cancelled** (`status='failed'`), **paused** (user stop), or **paused-with-error**
(`paused=true` + `jobs.error`, resumable via the normal resume route). Disposition is driven by the
DB control flags, not the error's `.code` (which may not survive the step boundary). Each batch is
an independent child run reporting `ok`/`failed`/`inactive` through its completion hook, so one bad
batch never cancels its siblings (a whole-`failed` wave still aborts early as a systemic-outage
guard, and an `inactive` child stops further waves); if **any** batch fails the
run is paused-with-error (never silently finalized), and a resume reprocesses only still-pending
domains via the idempotent queues. Finalize refuses to mark a job completed while
`jobHasRemainingPipelineWork` still finds queue rows — it pauses-with-error instead, and a
successful finalize clears `jobs.error` (and the auto-resume counter). Queue-based stages
(founders/emails/verify/personalization) carry `maxRetries=2`; shopping-audit steps carry
`maxRetries=1` — they are per-domain idempotent (serper skips domains with existing
`ad_observations` and hits the per-job response cache; the waterfall skips domains with existing
`signal_emissions`), so a retry or resume never re-charges Serper for processed domains. The
verify/email/personalize queues are scoped by the batch's domain list **in SQL**, so parallel
child runs cannot starve each other out of a global LIMIT window.

**Credit exhaustion (TryKitt):** a 402 whose body signals out-of-credits (or a 402 that
persists past retries) is detected in `services/trykittCredits.js` and raised as a
`CREDIT_EXHAUSTED` error from `emailFinder`/`emailVerifier`. Credit-failed rows are left
*unstamped* (`email_find_completed_at` / `email_verify_completed_at` stay NULL) so a resume
after top-up reprocesses exactly them, while partial successes are flushed first. On Vercel
this routes through `handleWorkflowFailure` → paused-with-error (`jobs.error` carries the
"add credits and resume" message); on PM2 it hits the existing `pauseJobWithError` handler.

**Watchdog:** Vercel Cron hits `/internal/enrichment/reap` every 10 min. It flips Vercel-runner jobs
stuck at `status='running'` with no `updated_at` movement for `ENRICHMENT_STALL_MINUTES` (default 20)
into paused-with-error — the backstop for a workflow that dies before its catch runs (eviction/OOM).
When pipeline queues still hold work it then **auto-resumes** the job (re-triggers the workflow
start route), at most `jobs.options.autoResumeAttempts = 2` times per successful finalize — after
that the job stays paused-with-error for a human. A duplicate start is rejected by
`guardWorkflowStart` and the parent ends that run without touching job state.

**Required env (Vercel + Express):** Postgres vars, `APP_URL`, `WORKFLOW_TRIGGER_SECRET`. Optional `SERPER_MAX_CONCURRENT_BATCHES` / `SERPER_RPM_LIMIT` for Postgres API throttling, `CRON_SECRET` to authenticate the reap cron, `ENRICHMENT_STALL_MINUTES` to tune the watchdog threshold.

**Shadow validation:** Run the same fixture job with `executionRunner: pm2` vs `vercel` and compare `contacts` + shopping audit tables before flipping the default.

### PM2-only queue worker (legacy default)

- The API **never** runs `processJob` inline. Upload and resume always enqueue `job_queue`.
- A dedicated worker process (`src/worker/queueWorker.js`) claims PM2 enrichment jobs and runs `runJobChild.js`.
- Child PID is stored on `job_queue.runner_pid` for hybrid stop (cooperative cancel, then SIGTERM/SIGKILL).
- Local dev: `npm run dev:all` in `server/` (API + worker), or run `npm run dev` and `npm run worker` in two terminals.
- Production: PM2 must run **both** `shields-outbound-server` and `shields-outbound-worker` (see `ecosystem.config.cjs`).

### Interested-reply research workflow (Vercel Workflows, reply path)

When Instantly marks a lead interested, the autoresponder normally drafts inline
(`createInterestedAutoResponderDraftFromEvent` in
`src/services/interestedAutoResponder.js`). Agencies with
`features.replyResearchAgent: true` instead get a **durable research run** on the
Workflows runtime before the draft is written:

1. Express (webhook / sync reconcile) inserts the draft shell at
   `status='researching'` and POSTs `/internal/interested-research/start`
   (`src/services/interestedResearch/trigger.js`, secured by
   `WORKFLOW_TRIGGER_SECRET` — same pattern as the enrichment trigger).
2. `workflows/interested-research.ts` runs one linear pipeline per draft:
   hydrate → homepage fetch + Serper sweep (agency's own Serper key, both
   best-effort) → LLM-synthesized brief persisted to
   `interested_autoresponder_drafts.research_brief`
   (`{ company, domain, industry, summary, talkingPoints, risks, sources,
   reviewCount, estimatedVisitors }`) → external
   popup/audit URL (Essence popup or Vulcan audit, exactly as the inline path) →
   `generateDraftReply` with the brief → promote to `pending_review` + ntfy.
3. Human review / send / warm follow-ups proceed unchanged.

Design rules:
- **Not enrichment.** No parent/child fan-out, no `job_queue`, no shared
  orchestrator — only libraries are shared. The Instantly webhook itself stays on
  PM2 and never blocks on research.
- **Draft row is the idempotency anchor.** Every step re-checks
  `status='researching'`; a superseded/cancelled draft ends the run cleanly
  (`RESEARCH_DRAFT_SUPERSEDED`). A crash marks the draft `generation_failed`
  via the keystone failure step — never stranded at `researching`.
- **Graceful degradation.** Trigger failure falls back to the inline draft path;
  thin research yields no brief but still a normal draft; a failed popup or brief
  never kills the run.
- **Statuses.** `researching` is an open status (counts toward the one-open-draft
  per contact+campaign invariant, cancelled when the lead leaves interested).
  Migration: `migrations/0048_interested_reply_research.sql`.
- Env: `WORKFLOW_TRIGGER_SECRET` + `APP_URL` required to trigger;
  `INTERESTED_RESEARCH_WORKFLOW_DISABLED=true` kills the path globally;
  `INTERESTED_RESEARCH_MODEL` overrides the brief model.

## Job Lifecycle

### 1) CSV Upload and Job Creation

Endpoint:

- POST /api/jobs

Behavior:

- Accepts a multipart CSV upload (domain list or pre-enriched data).
- Verifies Firebase ID token.
- Fetches API keys from Firestore user document:
  - openai_key
  - serper_key
  - trykitt_key (when provider is trykitt)
- Resolves client slug to numeric SQL client_id.
- Determines pipeline options:
  - skipFounderFinder
  - skipEmailFinder
  - skipVerification
  - industry / niche
  - personalizeFirstLine
  - columnMapping for domain/founder/email columns
- Creates a job record in memory and writes the input CSV to tmp/jobs/<jobId>/domains.csv.
- Runs dedupe against existing SQL domains, then enqueues the job for the worker.

### 2) Domain Prep

Purpose:

- Normalize domains and remove duplicates.
- Avoid reprocessing existing domains if dedupeStrategy is skip.
- DNS check to keep only processable domains.
- Prepare a clean CSV for downstream stages.

Details:

- filterAndWriteProcessedDomains
  - Normalizes and de-dupes input domains.
  - Queries SQL for existing domains by client_id.
  - If dedupeStrategy is skip, existing domains are removed.
  - Writes a deduped CSV for downstream use.
- dedupeDomainsCsv
  - Removes duplicate domains inside the CSV (defensive).
- dnsFilterDomainsCsv
  - Performs DNS lookups (A, AAAA, CNAME, MX) with concurrency.
  - Keeps live and unknown domains; drops dead domains.

Outputs:

- A cleaned CSV containing only processable domains.
- Dedupe stats stored on the job for progress reporting.

### 3) Immediate SQL Upsert (Companies + Placeholder Contacts)

Purpose:

- Reflect newly uploaded domains in the UI right after upload.
- Create placeholder contacts to allow lead lists to render.

Behavior:

- Batch upsert companies in SQL from the prepared domain list.
- Create placeholder contacts for each company (role_type = founder).

This is done before enrichment stages so the UI can show companies even if enrichment is slow.

### 4) Founders Stage (Optional)

Two modes:

- If skipFounderFinder is true:
  - buildFoundersCsvFromInput maps domain -> founder from the original CSV.
- Otherwise:
  - runFounderFinder uses Serper + OpenAI to infer founder or CEO names.
  - Results written to founders.csv
  - SQL upsert from founders.csv

Notes:

- Uses adaptive rate limiting for OpenAI requests.
- Supports checkpointing for resume safety.
- Pricing is tracked per stage and aggregated into job.cost.

### 5) Email Discovery Stage (Optional)

Two modes:

- If skipEmailFinder is true:
  - buildEmailsCsvFromInput maps domain -> founder/email from the original CSV.
- Otherwise:
  - runEmailFinder uses a provider to find email addresses.

Providers:

- trykitt: Calls https://api.trykitt.ai/job/find_email
- self_hosted: Enumerates email patterns and verifies via a self-hosted endpoint

Behavior:

- Writes emails.csv with domain, founder_name, email, lookup_status.
- Performs batch SQL upserts during processing and again after CSV write.
- Supports pause/resume and credit exhaustion handling.

### 6) Email Verification Stage (Optional)

Two modes:

- If skipVerification is true:
  - emails.csv is copied to final.csv without verification.
- Otherwise:
  - runEmailVerifier validates each email and writes final.csv.

Providers:

- trykitt: Calls https://api.trykitt.ai/job/verify_email
- self_hosted: Calls self-hosted verification endpoint and maps response

Behavior:

- Writes final.csv with email_status results.
- Upserts verification status to SQL contacts.

### 7) Personalization Stage (Optional)

Purpose:

- Generate first-line personalization from domain and enrichment data.

Behavior:

- runPersonalization dispatches to strategy based on industry or niche:
  - ecom, saas, agency, local, default
- Writes personalized.csv
- Upserts personalization_first_line to SQL contacts.

### 8) Unified Output CSVs

Outputs:

- final.csv: Verified leads (domain, founder_name, email, email_status)
- personalized.csv: First-line personalization results
- upload.csv: Unified rows for export or Instantly upload

buildUnifiedRows merges final.csv + personalized.csv by domain and builds:

- domain
- founder_name
- email
- email_status
- first_name
- last_name
- personalization

The upload.csv is used for Instantly uploads and exports.

## Job state and live UI (Postgres + Supabase Realtime)

**Persistence (source of truth):**

- Job rows live in Cloud SQL / Supabase `public.jobs` (`stages`, `status`, `cost`, `dedupe_stats`, `options`, etc.).
- The worker calls `persistJobState()` on progress and stage transitions (throttled during long stages; stage start/complete always flush).
- Live status text is stored in `jobs.options.activityMessage` / `activityUpdatedAt` (not a `logs` JSON column).

**Worker in-memory:**

- While a child process runs, `jobPipeline.js` keeps a Map for the active job (paths, API keys, throttling counters).
- That Map is not streamed to the browser; the UI reads Postgres via Realtime.

**Frontend (primary: Supabase Realtime):**

- `lib/hooks/useJobRealtime.ts` subscribes to `postgres_changes` on `jobs` (`UPDATE`, filtered by `id`).
- On subscribe, the hook also runs a one-shot `SELECT` for the current row.
- `app/clients/[clientId]/page.tsx` merges payloads into `jobState` (`mergeJobState`).
- `useClientJobsRealtime` listens for job `INSERT`/`UPDATE`/`DELETE` on the client and refreshes the job history list (debounced).

**Frontend (secondary REST, not streaming):**

- `GET /api/jobs/:id` — bootstrap when selecting or starting a watch (`fetchJobSnapshot`).
- `GET /api/clients/:clientId/active-job` — polled every ~3s while a run is active to discover which job to watch and start Realtime.

**Not used:** Server-Sent Events (`GET /api/jobs/:id/stream`), Firestore job documents, or 2s job snapshot polling during runs.

**Realtime setup:** migration `0022_supabase_rls_realtime.sql` (RLS on `jobs` + `supabase_realtime` publication). Browser auth must satisfy `jobs_agency_select`.

## Pause, Resume, Cancel

- Pause: Cooperative — `control.json` + DB; stages checkpoint between external calls; founder contacts upsert every **50** results.
- Stop: Sets `cancelled`, then hybrid terminate via `runner_pid` (8s cooperative, SIGTERM, SIGKILL).
- Resume: Re-enqueues the same `job_id`; worker continues from SQL/`job_domains`/Serper cache.

## Instantly Uploads

Endpoint:

- POST /api/jobs/:id/upload-to-instantly

Behavior:

- Uses the client Instantly API key from Firestore.
- Uploads verified leads from buildUnifiedRows scope = valid.
- Maps fields using columnMapping and optional custom variables.
- Writes upload status to Firestore activeJob and jobs doc.
- Tracks campaign membership in SQL contact_instantly_campaigns.

## SQL Tables (Key Touchpoints)

- clients: resolved from Firestore client slug
- companies: normalized domains per agency/client
- contacts: founder/email records, verification status, personalization
- instantly_campaigns: campaigns fetched from Instantly
- contact_instantly_campaigns: links contacts to campaigns
- job_stage_checkpoints: optional progress checkpoints

## Failure Handling

- Each stage runs in runStage wrapper.
- Stage errors:
  - Are recorded in job.stages[stage].error
  - Cause the job to pause (not fail permanently)
- Credit exhaustion is treated as a pause with a user-facing error.
- Cancelled jobs skip remaining stages; live UI updates come from Postgres via Supabase Realtime.

## Files and Paths

Temporary files live under:

- server/tmp/jobs/<jobId>/

## Running Personalization Locally From Domains Only

If you want the Shopify personalizer without the live server job flow, Firebase, Firestore, DB, founders, or emails, use:

```bash
cd server
OPENAI_API_KEY=... npm run personalizer:local -- --input /absolute/path/domains.csv
```

Notes:

- The input only needs a domain column.
- Default expected header is `domain`.
- If your CSV uses another header, pass `--domain-column website` (or whatever your column is named).
- Optional flags:
  - `--products-to-pull 5`
  - `--check-klaviyo`
  - `--remove-b2b`
- Output defaults to `server/tmp/jobs/local-personalizer-<timestamp>/personalized.csv`.

This runner calls `server/src/services/personalizerPipeline.js` directly and rewrites your input into the one-column `domain` shape that pipeline expects.

Key files:

- domains.csv: original input
- founders.csv: founder output
- emails.csv: email discovery output
- final.csv: verification output
- personalized.csv: personalization output
- upload.csv: unified export for upload

## Personalizer Pipeline (Shopify)

This is a separate endpoint and pipeline focused on Shopify store personalization.

Endpoint:

- POST /api/jobs/personalizer

Stages:

1) Shopify detection
2) Optional Klaviyo detection
3) Product fetch (products.json)
4) B2B filtering (optional)
5) OpenAI personalization

Outputs:

- personalized.csv in a job-specific tmp directory
- Firestore job document with stage progress and final metrics

## Key Components Reference

- Pipeline orchestration: server/src/services/jobPipeline.js
- Jobs API: server/src/routes/jobs.js
- Leads SQL upserts: server/src/services/leads.js
- DB utilities: server/src/lib/db.js
- CSV helpers: server/src/utils/csv.js
- Personalization strategies: server/src/services/personalization/
