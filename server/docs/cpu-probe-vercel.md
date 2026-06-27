# Dev note: measure active CPU per domain before the Vercel decision

## Why

We're weighing a move off the PM2 worker onto Vercel Workflows. Vercel bills active CPU, not wall-clock. Our runs spend almost all their time waiting on external APIs (Shopify catalog, Serper, trykitt, the personalization LLM), so wall-clock tells us nothing useful about the future bill. A 143s run might burn one or two seconds of real CPU. We need that real number.

This note covers one task: wrap a 300-domain run and capture active CPU-seconds per domain. That figure drops straight into the Vercel cost model. Without it, the compute side of the decision stays a guess.

## What to measure

`process.cpuUsage()` returns user + system CPU microseconds the process actually consumed. It ignores I/O wait, which is exactly what we want. Call it once at job start, once at job end, take the delta, divide by domain count.

Run 300 domains, not 50. Per-domain CPU on a 50-domain run is too noisy to trust; 300 averages out the slow domains and the retries.

## The instrumentation

Implemented in `jobPipeline.js` / `jobTiming.js`. CPU and wall-clock are captured at job start (before pipeline work) and logged after the final state persist on successful completion.

Look for this line in worker logs:

```
[job-id] [cpu-probe] domains=300 cpu_seconds=1.234 wall_seconds=143.2 cpu_per_domain_ms=4.1 cpu_wall_ratio=0.009
```

## What to report back

Paste the `[cpu-probe]` line. Five numbers:

- `domains` — confirms the sample size
- `cpu_seconds` — total active CPU for the run
- `wall_seconds` — total elapsed time
- `cpu_per_domain_ms` — the number that feeds the Vercel model
- `cpu_wall_ratio` — sanity check; expect something small, like 0.02 to 0.05, which means 2 to 5 percent of the run was real compute and the rest was waiting

If `cpu_per_domain_ms` lands where we expect (tens of milliseconds), the Vercel compute line is a rounding error and we stop worrying about it. If it comes back surprisingly high, we dig into why before committing.

## Two caveats, so nobody over-reads the result

This measures the pipeline's business-logic CPU, which is the floor of the Vercel number, not the final figure. The migrated version adds CPU that doesn't exist in our PM2 process: serializing step inputs and outputs, and the workflow orchestrator replaying its event log on each resume. That overhead scales with step count and state size. The probe can't see it. The only way to measure it is to run a slice on the real SDK.

So treat this as step one. It confirms whether compute is even worth discussing. If we want the true Vercel figure rather than the floor, step two is porting one stage (personalization is the candidate, it's self-contained and currently 20 sequential LLM calls) onto a Vercel preview deployment and reading active CPU and event count off the Workflows dashboard.

## Optional, ten extra minutes

While the 300-domain run is going, watch the process in `htop`. We should see it mostly idle with short bursts. That's a visual confirmation of the same thing the ratio proves: this workload is waiting, not computing. Worth a screenshot for the decision doc.
