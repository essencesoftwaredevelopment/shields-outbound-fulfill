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
- Runs dedupe against existing SQL domains, then begins pipeline processing.

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

## Job State, SSE, and Firestore

In-memory state:

- Jobs are tracked in a Map keyed by jobId.
- Each job holds stages, logs, paths, and options.

Realtime updates:

- Server-sent events (SSE) are used for streaming job logs and progress.
- Firestore persistence is throttled to reduce write cost:
  - Update every N records or after a minimum interval.
  - Stage transitions and completion always force an update.

Firestore documents:

- users/{uid}/clients/{clientId}/jobs/{jobId}
- users/{uid}/clients/{clientId}/activeJob/current

## Pause, Resume, Cancel

- Pause: Marks job as paused and persists state; processing aborts safely.
- Resume: Continues from in-memory state and existing checkpoints.
- Cancel: Marks job failed, closes streams, and persists state.

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
- Cancelled jobs close SSE streams and skip remaining stages.

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
