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

## Execution model (queue-only)

- The API **never** runs `processJob` inline. Upload and resume always enqueue `job_queue`.
- A dedicated worker process (`src/worker/queueWorker.js`) claims jobs and runs `runJobChild.js`.
- Child PID is stored on `job_queue.runner_pid` for hybrid stop (cooperative cancel, then SIGTERM/SIGKILL).
- Local dev: `npm run dev:all` in `server/` (API + worker), or run `npm run dev` and `npm run worker` in two terminals.
- Production: PM2 must run **both** `shields-outbound-server` and `shields-outbound-worker` (see `ecosystem.config.cjs`).

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
