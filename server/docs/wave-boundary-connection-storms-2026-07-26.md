# Wave-Boundary Connection Storms — State of Play (2026-07-26)

`Error: timeout exceeded when trying to connect` (pg-pool) in Vercel runtime
logs during enrichment jobs. This doc records what it is, why it is currently
harmless, and which levers remain if we want the noise gone. Supersedes the
"flip to the transaction pooler" plan — **that flip is already live**.

## Current state (verified, not assumed)

- Prod Vercel workflow traffic already rides the **Supavisor transaction-mode
  pooler** (`aws-1-eu-central-1.pooler.supabase.com:6543`, user
  `postgres.xfamwraegljpmvsdimrp`). Evidence: `pg_stat_activity` shows the
  enrichment queries (`try_acquire_api_lease`) executing on `Supavisor`-owned
  backends, one of them 5 days old — shared long-lived backends are
  transaction-mode multiplexing, impossible for per-lambda direct or
  session-pinned connections. (Earlier notes claiming prod was on direct 5432
  are outdated.)
- Pooler config re-validated from a real `pg` client 2026-07-26: connect 670 ms,
  unnamed parameterized statements, `BEGIN; SET LOCAL …; COMMIT`
  (the `queryWithStatementTimeout` pattern), 8-way burst through a max-4 pool.
- Mitigations from the morning sprint are active and working:
  `ENRICHMENT_CHILD_WAVE_CONCURRENCY=6`, `PGPOOL_MAX=4`, connect-timeout
  retryable in `queryWithPoolRetry` (100 ms → 2 s capped backoff, 15 s budget),
  emails/verify/personalization steps `maxRetries 2`.

## The residual mechanism

Log histogram (job `1785083216354-82fzda`, 10,061 domains): error bursts of
~230–590 in a single minute at 16:29, 16:40–41, 16:52 — **exactly the ~11-min
wave boundaries** — and silence in between. Same signature earlier at 13:59
(731) and 14:44 (795) for the validation job. Zero step failures; the job
progressed through every burst.

At a wave boundary, 6 child isolates cold-start simultaneously. Each brings a
fresh pg pool (max 4) needing fresh TLS+auth handshakes to Supavisor, and the
emails step immediately fans out finder workers that each poll the SQL rate
gate (`try_record_rate_limit_event` / `try_acquire_api_lease`) via
`queryWithPoolRetry`. Hundreds of near-simultaneous acquire attempts contend
for 4 local slots each + a synchronized handshake herd; the stragglers hit
pg-pool's 30 s `connectionTimeoutMillis`, log the error, back off, and succeed
on retry. Postgres itself never sees a failure.

## Cost of doing nothing

Log noise plus a few seconds of retry latency per wave boundary. All bursts are
fully absorbed by design (that was the point of the morning's hardening). This
is an acceptable steady state.

## Levers if we want the noise gone (ranked)

1. ✅ **SHIPPED — sliding-window child scheduling** (same change-set as this
   doc's update). `workflows/enrichment-parent.ts` no longer runs waves at all:
   `waveConcurrency` children stay in flight continuously, each spawned by its
   own step the moment a slot frees (`lib/enrichment/slidingWindow.ts` holds
   the pure scheduler; the parent consumes a single shared completion hook
   with `for await` — per-child `Promise.race` collapsed concurrency, see
   job 1787155726011-2lozbz). This removes the
   synchronized wave-boundary cold-start herd (spawns serialize through parent
   steps and thereafter follow completion events) AND stops the whole job
   waiting on each wave's slowest child (e.g. TryKitt verification tails).
2. **Amortize the rate-gate polling** — per-isolate token dispenser so N finder
   workers share one in-flight lease query instead of N concurrent polls.
   Bigger change; the per-call SQL gate exists for cross-isolate correctness,
   so touch carefully.
3. **`PGPOOL_MAX` 4 → 8** — txn pooler multiplexes, so backend-side this is
   safe; relieves intra-step acquire contention (the actual 30 s queue), and
   the herd concern shrinks now that cold-starts are staggered.
4. **Supavisor pool size bump** (dashboard → Database → Connection pooling) —
   more backend headroom per user+db during bursts. Secondary.
5. **Raise `connectionTimeoutMillis` for the enrichment path** (30 s → 60 s) —
   waits out stragglers instead of erroring into retries. Pure symptom
   suppression; last resort.

## Monitoring recipe

- Burst check: Vercel runtime logs, query `timeout exceeded when trying to
  connect`, bucket per minute — bursts should align with wave boundaries and
  stay absorbed (no `paused-with-error`, stages advancing).
- Backend view during a boundary:
  `SELECT application_name, state, COUNT(*) FROM pg_stat_activity
   WHERE backend_type = 'client backend' GROUP BY 1,2;`
  Supavisor rows spike then settle; total stays far under `max_connections=60`.
