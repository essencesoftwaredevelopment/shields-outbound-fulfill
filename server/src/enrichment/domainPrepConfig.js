/** DNS domain-prep tuning (shared by Vercel enrichment + PM2 jobPipeline). */
export const DNS_QUERY_TIMEOUT_MS = Math.max(
    500,
    parseInt(process.env.DOMAIN_PREP_DNS_TIMEOUT_MS || '2500', 10)
);

// 200 domains x 4 lookups flooded the resolver on Vercel: most answers came back
// as fast non-miss errors and ~95% of live domains were marked unknown.
export const DNS_CHECK_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.DOMAIN_PREP_DNS_CONCURRENCY || '50', 10)
);

/** Second, gentler pass for domains the first pass could not classify. */
export const DNS_RECHECK_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.DOMAIN_PREP_DNS_RECHECK_CONCURRENCY || '10', 10)
);

/** Wall-clock cap on the recheck pass so a huge job can't stall domain prep. */
export const DNS_RECHECK_BUDGET_MS = Math.max(
    0,
    parseInt(process.env.DOMAIN_PREP_DNS_RECHECK_BUDGET_MS || '120000', 10)
);

/** How often to poll cancel/pause during DNS (avoid a DB round-trip per domain). */
export const DOMAIN_PREP_CANCEL_CHECK_EVERY = Math.max(
    1,
    parseInt(process.env.DOMAIN_PREP_CANCEL_CHECK_EVERY || '50', 10)
);
