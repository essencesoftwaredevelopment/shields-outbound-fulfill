# Shields Outbound

An automated lead generation and enrichment platform for outbound sales campaigns. This application processes company domains through a multi-stage pipeline to identify founders, verify emails, and generate personalized outreach content.

## Architecture Overview

Shields Outbound is a full-stack TypeScript/JavaScript application with a Next.js frontend and Express backend. Pipeline job progress is persisted to Postgres and pushed to the UI primarily via **Supabase Realtime** (`postgres_changes` on `jobs`). The system processes CSV files through a sequential pipeline, with each stage producing intermediate CSV files that feed into the next stage.

### System Components

**Frontend (Next.js + React)**
- **User Interface**: File upload, job creation, real-time progress monitoring
- **Authentication**: Firebase Auth with JWT token verification
- **API Key Vault**: Secure storage/retrieval of API keys per user in Firestore
- **Client Management**: Multi-tenant client organization with lead tracking
- **Job Realtime**: Supabase Realtime subscription on `jobs` (`lib/hooks/useJobRealtime.ts`)

**Backend (Express + Node.js)**
- **Job Pipeline Orchestration**: Sequential stage execution with state management
- **API Integrations**: OpenAI, Serper, TryKitt for data enrichment
- **CSV Processing**: Stream-based parsing/writing for memory efficiency
- **Firebase Admin**: Firestore writes for leads, jobs, and client data
- **Webhook Support**: Incoming lead capture and webhook processing

**Data Storage**
- **Postgres (Cloud SQL / Supabase)**: Jobs, job domains, leads, queue (`public.jobs`, etc.)
- **Firebase Firestore**: Auth-linked settings, API keys, and legacy client metadata where still referenced
- **File System**: Temporary CSV files for each job stage (`server/tmp/jobs/{jobId}/`)
- **In-Memory (worker only)**: Active job map while a child process runs; not streamed to the browser

## How It Works

### 1. Job Creation & Upload Flow

**Frontend Process:**
```
User uploads CSV → createPipelineJob() → FormData with file + idToken + options
                                       → POST /api/jobs
```

**Backend Process:**
```
/api/jobs endpoint
  → Verify Firebase ID token (authenticate user)
  → Fetch user's API keys from Firestore (openai_key, serper_key, trykitt_key)
  → Parse CSV buffer, write to tmp/{jobId}/domains.csv
  → Create job record with stage state machines (pending/running/completed/error)
  → Run deduplication synchronously:
      • Query Firestore for processed-domains under client
      • Filter out duplicates (skip strategy) or track stats (include strategy)
      • Write filtered list to tmp/{jobId}/domains-filtered.csv
  → Respond with jobId immediately
  → Enqueue job on `job_queue` (worker runs `processJob` in a child process)
```

### 2. Real-Time Job Monitoring

**Supabase Realtime (primary):**
```
Worker persists job → UPDATE public.jobs
  → Supabase Realtime postgres_changes (filtered by job id)
  → useJobRealtime() in the client page
  → mergeJobState() updates stage cards, % complete, activityMessage, cost
```

**REST (secondary, not streaming):**
- `GET /api/jobs/:id` once when a watch starts or a job is selected (catch-up snapshot)
- `GET /api/clients/:clientId/active-job` polled ~every 3s while a run is active (discovers which job to subscribe to)

**State management:**
- Source of truth: `public.jobs` row (`stages`, `status`, `cost`, `options.activityMessage`, …)
- Each stage tracks: status, startedAt, completedAt, summary, error, progress
- Progress updates include: processed count, total count, cost accumulation

**Not used:** SSE (`/api/jobs/:id/stream`), Firestore job documents, or periodic job snapshot polling during runs.

### 3. Pipeline Stage Execution

Each stage follows this pattern:
```javascript
await runStage(job, 'stageName', async () => {
  // 1. Read input CSV from previous stage
  // 2. Process rows with external API calls (rate-limited, retries)
  // 3. Emit progress updates via log(job, message, {progress: {...}})
  // 4. Write output CSV for next stage
  // 5. Upsert results to Firestore leads collection
  // 6. Return summary (processed count, cost, etc.)
})
```

#### Stage 1: Founder Discovery

**Technology**: Serper API (Google Search) + OpenAI GPT-4

**Process:**
```
Input: domains.csv (domain column)
  → Batch domains into groups of 25
  → For each domain:
      1. Serper search: "{domain} founder CEO" (adaptive rate limiting)
      2. Extract top 10 organic results (title, snippet, link)
      3. Truncate content to 900 chars per result
      4. OpenAI prompt: "Extract founder name from search results"
      5. Parse JSON response: {founder_name: "John Doe"}
  → Adaptive rate limiting:
      • Starts at maxRpm, reduces to 70% on 429 errors
      • Increases to 110% after 50 consecutive successes
      • Maintains sliding window of timestamps for precise throttling
  → Checkpoint system: Save progress every N domains for crash recovery
Output: founders.csv (domain, founder_name)
  → Upsert to Firestore: /users/{uid}/clients/{clientId}/leads/{domain}
```

**Skip Logic**: If CSV includes `founder_name` column, stage is skipped and data is passed through.

#### Stage 2: Email Discovery

**Technology**: TryKitt API (email finder)

**Process:**
```
Input: founders.csv (domain, founder_name)
  → Filter out rows with founder_name='Not found'
  → Concurrent processing (limit: 10)
  → For each founder:
      POST /job/find_email {fullName, domain, realtime: true, strictNameMatches: false}
      → Retry with exponential backoff on 402/429/5xx (max 5 attempts)
      → Extract email from various response formats
      → Mark status: 'Found', 'Not Found', 'API Error'
Output: emails.csv (domain, founder_name, email, lookup_status)
  → Upsert to Firestore leads collection
```

**Skip Logic**: If CSV includes `email` column, stage is skipped.

#### Stage 3: Email Verification

**Technology**: TryKitt API (email verifier)

**Process:**
```
Input: emails.csv (domain, founder_name, email, lookup_status)
  → Filter to only emails with lookup_status='Found'
  → Concurrent processing (limit: 15)
  → For each email:
      POST /job/verify_email {email, realtime: true}
      → Retry with exponential backoff (max 5 attempts)
      → Parse validity: 'valid', 'invalid', 'risky', 'unknown'
Output: final.csv (domain, founder_name, email, email_status)
  → Upsert to Firestore with email_status
```

**Skip Logic**: Configurable via `skipVerification` flag.

#### Stage 4: Personalization

**Technology**: Industry-specific strategies using OpenAI + web scraping

**Strategy Selection:**
```javascript
const strategies = {ecom, saas, agency, local};
const handler = strategies[job.nicheId] || runDefault;
```

**E-commerce Strategy (Most Complex):**
```
1. Shopify Detection:
   → DNS A record check for 23.227.38.* IPs
   → DNS CNAME check for myshopify.com
   → Concurrent processing (200 domains at once)
   
2. Product Scraping (Shopify stores only):
   → Fetch domain/products.json (Shopify API endpoint)
   → Parse product data (title, description, image, variants)
   → Filter out B2B keywords (wholesale, bulk, distributor)
   → Clean products.json → products-cleaned.csv
   
3. AI Personalization:
   → For each lead with email_status in ['valid', 'risky', 'Found']:
       • Build prompt with founder name + product catalog
       • OpenAI: Generate personalized first line + angle
       • Extract: first_line, title, description, url, date
   → Concurrent processing with rate limiting
   
Output: personalized.csv (domain, url, title, description, date, first_line)
  → Upsert to Firestore leads
```

**Other Strategies:**
- **SaaS**: Website scraping + feature analysis
- **Agency**: Service offering detection
- **Local**: Geographic/industry-specific messaging
- **Default**: Generic personalization without deep research

### 4. Data Flow & CSV Structure

```
domains.csv                    → User upload
  ↓
domains-filtered.csv           → After deduplication
  ↓
founders.csv                   → domain, founder_name
  ↓
emails.csv                     → domain, founder_name, email, lookup_status
  ↓
final.csv                      → domain, founder_name, email, email_status
  ↓
shopify-detection.csv          → domain, shopify, founder_name, email, email_status
  ↓
products.json / products-cleaned.csv  → Shopify product data
  ↓
personalized.csv               → domain, url, title, description, date, first_line
  ↓
upload.csv                     → Unified export with all enrichments
```

**Unified Export (upload.csv):**
Combines all stages into single row per domain:
```
domain, founder_name, email, email_status, first_name, last_name,
personalization, personalization_first_line, personalization_title,
personalization_url, product_title
```

### 5. Deduplication & Lead Management

**Domain Tracking:**
```
Firestore: /users/{uid}/clients/{clientId}/processed-domains/{domain}
  → domain: lowercased domain string
  → lastJobId: most recent job that processed this domain
  → jobs: array of all jobIds that touched this domain
  → createdAt, updatedAt: timestamps
```

**Strategies:**
- **Skip**: Filter out previously processed domains before pipeline starts
- **Include**: Process all domains but track which are new vs. duplicates

**Lead Upsert:**
After each stage, results are merged into Firestore:
```
/users/{uid}/clients/{clientId}/leads/{domain}
  → domain, founder_name, email, email_status
  → personalization_url, personalization_title, personalization_first_line
  → updatedAt: server timestamp
  → Merge strategy: existing fields preserved, new fields added
```

### 6. Cost Tracking & Pricing

**Per-Stage Pricing:**
```javascript
pricing: {
  stages: {
    founders: { perRow: 0.05 },    // Serper + OpenAI call
    emails: { perRow: 0.02 },      // TryKitt email finder
    verification: { perRow: 0.01 }, // TryKitt verifier
    personalization: { perRow: 0.03 } // OpenAI + scraping
  }
}
```

**Cost Calculation:**
- Accumulated after each stage completes
- Based on actual processed rows (not input count)
- Stored in job.cost for Stripe billing
- User-specific pricing can override defaults via Firestore

### 7. Error Handling & Resilience

**Retry Logic:**
- Exponential backoff with jitter for API rate limits
- Max retries: 2-5 depending on operation
- Adaptive rate limiting adjusts to API quota responses

**Checkpointing:**
- Founder finder saves progress periodically
- Crash recovery continues from last checkpoint

**Graceful Degradation:**
- Missing founder → skip to next stage
- Email not found → mark as 'Not Found', continue
- Personalization failure → generic fallback

**Job State Recovery:**
- Active jobs persisted to Firestore every state change
- In-memory job map can be reconstructed on server restart

## Tech Stack

## Getting Started

1) Install deps if you haven't yet:
```bash
npm install
npm install --prefix server
```

2) Ensure the frontend points at the local Express server (ports can be changed if needed):
```
SERVER_URL=http://localhost:4000
NEXT_PUBLIC_PIPELINE_URL=http://localhost:4000
```
These defaults live in `.env`, so `npm run dev:all` will already use them.

3) Run both the Next.js app (port 3000) and the Express server (port 4000) together:
```bash
npm run dev:all
```
The Next.js dev server rewrites `/api/*` to the Express backend, so the UI talks to the locally started server automatically.

### Useful commands
- `npm run dev:app` — start only the Next.js app
- `npm run dev:server` — start only the Express server in `server/`
- `npm run dev:all` — start both servers concurrently for local development

## Tech Stack

**Frontend:**
- Next.js 16 with App Router
- React 19 with TypeScript
- Tailwind CSS v4 for styling
- Firebase SDK (Auth + Firestore client)
- Supabase JS client for Realtime (`postgres_changes` on `jobs`)
- Stripe.js for payment processing

**Backend:**
- Express.js with async/await
- Firebase Admin SDK (Firestore + Auth verification)
- csv-parse & csv-stringify for stream processing
- multer for multipart/form-data uploads
- p-limit for concurrency control
- node-fetch for HTTP requests

**External APIs:**
- OpenAI GPT-4 (founder identification, personalization)
- Serper API (Google search results)
- TryKitt API (email finding & verification)
- Stripe API (payment processing)

**Infrastructure:**
- Firebase Firestore (NoSQL database)
- File system storage (temporary job files)
- PM2 process manager (production deployment)

## Getting Started

### Prerequisites

1. **Firebase Project**: Create project at console.firebase.google.com
   - Enable Authentication (Email/Password)
   - Create Firestore database
   - Generate Admin SDK credentials

2. **API Keys**: Obtain keys from:
   - OpenAI (platform.openai.com)
   - Serper (serper.dev)
   - TryKitt (trykitt.ai)
   - Stripe (dashboard.stripe.com)

3. **Environment Variables**:

Create `.env` in project root:
```bash
# Frontend
NEXT_PUBLIC_PIPELINE_URL=http://localhost:4000
NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your_project_id

# Backend (server/.env)
PORT=4000
PGHOST=aws-1-eu-central-1.pooler.supabase.com
PGPORT=5432
PGDATABASE=postgres
PGUSER=postgres.xfamwraegljpmvsdimrp
PGPASSWORD=<supabase-password>
PGSSLMODE=require
DB_WRITE_FREEZE=false
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_CLIENT_EMAIL=your_service_account_email
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
STRIPE_SECRET_KEY=sk_test_...
OPENAI_FOUNDER_MODEL=gpt-4o-mini
FOUNDER_AI_CONCURRENCY=15
FOUNDER_AI_MIN_RPM=120
FOUNDER_AI_MAX_RPM=900
FOUNDER_AI_RECOVERY_SUCCESS_THRESHOLD=25
FOUNDER_RESET_RPM_ON_RESUME=true

# Optional single-string form if your deploy target prefers it
DATABASE_URL=postgresql://postgres.xfamwraegljpmvsdimrp:<supabase-password>@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require
```

### Installation

1) Install deps if you haven't yet:
```bash
npm install
npm install --prefix server
```

2) Ensure the frontend points at the local Express server (ports can be changed if needed):
```
SERVER_URL=http://localhost:4000
NEXT_PUBLIC_PIPELINE_URL=http://localhost:4000
```
These defaults live in `.env`, so `npm run dev:all` will already use them.

3) Run both the Next.js app (port 3000) and the Express server (port 4000) together:
```bash
npm run dev:all
```
The Next.js dev server rewrites `/api/*` to the Express backend, so the UI talks to the locally started server automatically.

### Useful commands
- `npm run dev:app` — start only the Next.js app
- `npm run dev:server` — start only the Express server in `server/`
- `npm run dev:all` — start both servers concurrently for local development

## API Endpoints

### Jobs
- `POST /api/jobs` - Create new job (multipart/form-data)
- `GET /api/jobs/:id` - Job snapshot (stages, status, cost; used on watch start, not streamed)
- `GET /api/jobs/:id/result?scope=all|valid` - Download CSV result
- `POST /api/jobs/:id/upload` - Upload to campaign with column mapping
- `POST /api/jobs/:id/pause` - Pause running job
- `POST /api/jobs/:id/resume` - Resume paused job
- `POST /api/jobs/:id/cancel` - Cancel job
- `POST /api/jobs/:id/csv-preview` - Preview unified CSV for mapping

### Clients
- `GET /api/clients/:clientId/leads` - Fetch paginated leads
- `POST /api/clients/:clientId/leads` - Create/update lead
- `DELETE /api/clients/:clientId/leads/:domain` - Delete lead
- `GET /api/clients/:clientId/leads/export` - Export all leads as CSV

### Webhooks
- `POST /webhook/lead` - Incoming lead capture webhook

## Deployment

### Server Deployment (PM2)

```bash
cd server
npm install --production
pm2 start src/index.js --name shields-outbound
pm2 save
pm2 startup
```

See [server/PM2_COMMANDS.md](server/PM2_COMMANDS.md) for detailed PM2 management commands.

Migration and cutover runbook: [server/SUPABASE_MIGRATION_RUNBOOK.md](server/SUPABASE_MIGRATION_RUNBOOK.md)

### Frontend Deployment (Vercel/Netlify)

```bash
npm run build
npm start  # or deploy to Vercel
```

Update environment variables in hosting platform dashboard.

## Configuration

Required API keys (stored in Firebase per-client):
- OpenAI API key
- Serper API key
- TryKitt API key
- Stripe API key (for payments)

## File Structure

```
shields-outbound/
├── app/                      # Next.js app directory
│   ├── page.tsx             # Job creation UI
│   ├── clients/[clientId]/  # Client & lead management
│   ├── api/stripe/          # Stripe checkout handlers
│   └── auth/                # Authentication pages
├── components/              # React components
├── lib/                     # Client-side utilities
│   ├── firebase/           # Firebase client config
│   ├── hooks/              # useJobRealtime, useClientJobsRealtime
│   └── pipeline/           # API client for backend
├── server/                  # Express backend
│   ├── src/
│   │   ├── index.js        # Express app entry
│   │   ├── routes/         # API route handlers
│   │   ├── services/       # Business logic
│   │   │   ├── jobPipeline.js        # Main orchestrator
│   │   │   ├── founderFinder.js      # Stage 1
│   │   │   ├── emailFinder.js        # Stage 2
│   │   │   ├── emailVerifier.js      # Stage 3
│   │   │   ├── personalization/      # Stage 4
│   │   │   └── leads.js              # Firestore operations
│   │   ├── config/         # Environment & Firebase setup
│   │   └── utils/          # CSV processing, pricing
│   └── tmp/jobs/           # Temporary CSV storage per job
└── public/                  # Static assets
```

## Monitoring & Debugging

**Server Logs:**
```bash
pm2 logs shields-outbound
pm2 monit  # Real-time monitoring
```

**Job Files:**
Temporary files stored in `server/tmp/jobs/{jobId}/`:
- `domains.csv` - Original upload
- `domains-filtered.csv` - After deduplication
- `founders.csv` - Stage 1 output
- `emails.csv` - Stage 2 output
- `final.csv` - Stage 3 output
- `personalized.csv` - Stage 4 output
- `upload.csv` - Unified export

**Firestore Collections:**
```
/users/{uid}
  /clients/{clientId}
    - name, industry, totalLeads
    /leads/{domain}
      - domain, founder_name, email, email_status, personalization_*
    /processed-domains/{domain}
      - domain, lastJobId, jobs[]
    /campaigns/{campaignId}
      - name, leadCount, instantly_key
  /jobs/{jobId}
    - status, stages, cost, clientId
```

## Performance Characteristics

**Throughput:**
- Founder finding: variable; typically constrained by OpenAI + Serper latency and configured concurrency/RPM caps
- Email finding: ~2000 emails/hour
- Verification: ~3000 emails/hour
- Personalization: ~200-400 leads/hour (varies by strategy)

**Resource Usage:**
- Memory: ~200MB base + ~10MB per active job
- Disk: ~5MB per 1000 domains processed
- CPU: Minimal (I/O bound, not compute intensive)

**Scaling Considerations:**
- Horizontal: Run multiple server instances with shared Firestore
- Vertical: Increase concurrency limits for faster processing
- Rate limits: Respect API provider quotas (adjustable in code)

## Troubleshooting

**Jobs stuck in "running" state:**
- Check server logs for uncaught errors
- Verify API keys are valid and have credit
- Check tmp/ directory permissions

**High API costs:**
- Adjust pricing in `server/src/utils/pricing.js`
- Reduce concurrency to lower API usage
- Enable more aggressive deduplication

**Missing leads in Firestore:**
- Verify Firebase credentials are correct
- Check Firestore rules allow writes
- Look for BulkWriter errors in logs

**Pipeline UI not updating during a run:**
- Confirm `0022_supabase_rls_realtime.sql` ran and `jobs` is in the `supabase_realtime` publication
- Check browser auth: RLS policy `jobs_agency_select` must allow `SELECT` for the signed-in agency
- Verify the worker is running (`shields-outbound-worker` / `npm run worker`) and `persistJobState` is not failing in server logs
- In DevTools, confirm a Supabase channel is subscribed for `job-realtime-{jobId}`

## Contributing

This is a proprietary application for ESSENCE Service Delivery. Contact the development team for contribution guidelines.

## License

Proprietary - ESSENCE Service Delivery © 2026
