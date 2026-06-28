/** DNS domain-prep tuning (shared by Vercel enrichment + PM2 jobPipeline). */
export const DNS_QUERY_TIMEOUT_MS = Math.max(
    500,
    parseInt(process.env.DOMAIN_PREP_DNS_TIMEOUT_MS || '2500', 10)
);

export const DNS_CHECK_CONCURRENCY = Math.max(
    1,
    parseInt(process.env.DOMAIN_PREP_DNS_CONCURRENCY || '200', 10)
);

/** How often to poll cancel/pause during DNS (avoid a DB round-trip per domain). */
export const DOMAIN_PREP_CANCEL_CHECK_EVERY = Math.max(
    1,
    parseInt(process.env.DOMAIN_PREP_CANCEL_CHECK_EVERY || '50', 10)
);
