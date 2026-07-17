import { promises as dns } from 'dns';
import { mapWithConcurrency } from '../lib/concurrency.js';
import { pool } from '../config/db.js';
import { filterJobDomainsForDedupe } from '../services/leads.js';
import {
    listPendingJobDomains,
    countJobDomainsByStatus,
    enrichJobDomainCohortFlags
} from '../services/db/jobs.js';
import { withTx, batchUpsertCompanies, batchUpsertContacts } from '../lib/db.js';
import { contextToJob } from './context.js';
import { assertJobActive, updateJobStage, setJobActivity } from './persist.js';
import { isShoppingAuditJob } from '../services/shoppingAudit/index.js';
import { createDebouncedAsync } from '../lib/singleFlight.js';
import { env } from '../config/env.js';
import {
    DNS_QUERY_TIMEOUT_MS,
    DNS_CHECK_CONCURRENCY
} from './domainPrepConfig.js';

if (env.PGPOOL_MAX <= 10 && DNS_CHECK_CONCURRENCY > 50) {
    console.warn(
        `[domainPrep] PGPOOL_MAX=${env.PGPOOL_MAX} is low for workflow DNS at concurrency ${DNS_CHECK_CONCURRENCY} — set PGPOOL_MAX=10+ in env`
    );
}

const PLACEHOLDER_CONTACT_MAX_DOMAINS = Math.max(
    0,
    parseInt(process.env.PLACEHOLDER_CONTACT_MAX_DOMAINS || '5000', 10)
);

function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            const err = new Error(`DNS lookup timeout after ${timeoutMs}ms`);
            err.code = 'DNS_TIMEOUT';
            reject(err);
        }, timeoutMs);
        promise.then(
            (value) => { clearTimeout(timeout); resolve(value); },
            (error) => { clearTimeout(timeout); reject(error); }
        );
    });
}

function isDnsMiss(error) {
    const code = String(error?.code || '').toUpperCase();
    return ['ENOTFOUND', 'ENODATA', 'ENONAME', 'EAI_NONAME', 'NXDOMAIN', 'NOTFOUND', 'NODATA'].includes(code);
}

async function checkDomainDns(domain) {
    const lookups = [
        dns.resolve4(domain),
        dns.resolve6(domain),
        dns.resolveCname(domain),
        dns.resolveMx(domain)
    ].map((lookup) => withTimeout(lookup, DNS_QUERY_TIMEOUT_MS));

    const settled = await Promise.allSettled(lookups);
    const hasAnyRecord = settled.some(
        (result) => result.status === 'fulfilled' && Array.isArray(result.value) && result.value.length > 0
    );
    if (hasAnyRecord) return { domain, status: 'live' };

    const errors = settled.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (errors.length > 0 && errors.every(isDnsMiss)) return { domain, status: 'dead' };
    return { domain, status: 'unknown' };
}

const DNS_STATUS_FLUSH_SIZE = 100;

/** Persist per-domain DNS cells so mid-run crashes leave a recoverable spreadsheet. */
async function flushDnsStatusBatch(jobId, buckets) {
    const entries = Object.entries(buckets).filter(([, domains]) => domains.length);
    for (const [status, domains] of entries) {
        const unique = [...new Set(domains)];
        if (!unique.length) continue;
        if (status === 'dead') {
            await pool.query(
                `UPDATE job_domains
                    SET dns_status = 'dead',
                        dns_checked_at = NOW(),
                        status = 'skipped',
                        updated_at = NOW()
                  WHERE job_id = $1
                    AND domain_normalized = ANY($2::text[])`,
                [jobId, unique]
            );
        } else {
            await pool.query(
                `UPDATE job_domains
                    SET dns_status = $3,
                        dns_checked_at = NOW(),
                        updated_at = NOW()
                  WHERE job_id = $1
                    AND domain_normalized = ANY($2::text[])`,
                [jobId, unique, status]
            );
        }
        buckets[status] = [];
    }
}

async function markDnsSkippedForJob(jobId) {
    await pool.query(
        `UPDATE job_domains
            SET dns_status = 'skipped',
                dns_checked_at = NOW(),
                updated_at = NOW()
          WHERE job_id = $1
            AND dns_status IS NULL`,
        [jobId]
    );
}

async function dnsFilterDomains(jobId, agencyId, onProgress) {
    const pending = await listPendingJobDomains(jobId);
    // Resume: only domains that still lack a DNS cell.
    const uniqueDomains = pending
        .filter((r) => !r.dns_status)
        .map((r) => r.domain_normalized)
        .filter(Boolean);
    if (!uniqueDomains.length) {
        const counts = await countJobDomainsByStatus(jobId);
        const { rows } = await pool.query(
            `SELECT
                COUNT(*) FILTER (WHERE dns_status IS NOT NULL)::int AS checked,
                COUNT(*) FILTER (WHERE dns_status = 'live')::int AS live,
                COUNT(*) FILTER (WHERE dns_status = 'dead')::int AS dead,
                COUNT(*) FILTER (WHERE dns_status = 'unknown')::int AS unknown
             FROM job_domains WHERE job_id = $1`,
            [jobId]
        );
        return {
            checked: Number(rows[0]?.checked ?? 0),
            live: Number(rows[0]?.live ?? 0),
            dead: Number(rows[0]?.dead ?? 0),
            unknown: Number(rows[0]?.unknown ?? 0),
            processable: counts.pending || 0
        };
    }

    // DNS is network-bound; DB checks must not run inside the concurrent worker loop
    // (PGPOOL_MAX is often small in dev:app workflow — concurrent getJobById exhausts the pool).
    const flushProgress = onProgress
        ? createDebouncedAsync(async (processed, total) => {
            try {
                await assertJobActive(jobId, agencyId);
                await onProgress(processed, total);
            } catch (err) {
                // Best-effort progress flush. It runs fire-and-forget (`void` below), so a
                // pause/cancel mid-DNS must NOT escape as an unhandledRejection (which can
                // crash the process). The DNS loop's own checkpoints handle the real stop.
                if (err?.code !== 'JOB_PAUSED' && err?.code !== 'JOB_CANCELLED') {
                    console.warn(`[domainPrep] progress flush failed: ${err?.message || err}`);
                }
            }
        }, 750)
        : null;

    let completed = 0;
    const checks = await mapWithConcurrency(
        uniqueDomains,
        DNS_CHECK_CONCURRENCY,
        async (domain) => {
            const result = await checkDomainDns(domain);
            completed += 1;
            if (flushProgress) {
                void flushProgress(completed, uniqueDomains.length);
            }
            return result;
        }
    );

    // Write spreadsheet cells in chunks (live/dead/unknown), not only dead→skipped.
    const buckets = { live: [], dead: [], unknown: [] };
    let live = 0;
    let dead = 0;
    let unknown = 0;
    for (const result of checks) {
        const status = result?.status || 'unknown';
        const domain = result?.domain;
        if (!domain) continue;
        if (status === 'live') live += 1;
        else if (status === 'dead') dead += 1;
        else unknown += 1;
        if (buckets[status]) buckets[status].push(domain);
        const pendingCount = buckets.live.length + buckets.dead.length + buckets.unknown.length;
        if (pendingCount >= DNS_STATUS_FLUSH_SIZE) {
            await flushDnsStatusBatch(jobId, buckets);
        }
    }
    await flushDnsStatusBatch(jobId, buckets);

    if (flushProgress) {
        await flushProgress(uniqueDomains.length, uniqueDomains.length);
    }

    const counts = await countJobDomainsByStatus(jobId);
    return {
        checked: uniqueDomains.length,
        live,
        dead,
        unknown,
        processable: counts.pending || 0
    };
}

async function upsertInitialDomains(ctx) {
    const pending = await listPendingJobDomains(ctx.jobId);
    const uniqueDomains = pending.map((r) => r.domain_normalized).filter(Boolean);
    if (!uniqueDomains.length || !ctx.clientId) return;

    await withTx(async (client) => {
        const domainMap = await batchUpsertCompanies(
            client,
            ctx.agencyId,
            ctx.clientId,
            uniqueDomains.map((domain) => ({ domain }))
        );
        if (uniqueDomains.length <= PLACEHOLDER_CONTACT_MAX_DOMAINS) {
            const contactPayloads = Array.from(domainMap.values()).map((companyId) => ({
                company_id: companyId,
                role_type: 'founder',
                job_id: ctx.jobId
            }));
            if (contactPayloads.length) {
                await batchUpsertContacts(client, ctx.agencyId, ctx.clientId, contactPayloads);
            }
        }
    });
}

/**
 * @param {import('./context.js').EnrichmentContext} ctx
 */
export async function runDomainPrep(ctx) {
    const job = contextToJob(ctx);
    const stages = ctx.stages || {};
    if (stages.domainPrep?.status === 'completed') {
        return stages.domainPrep.summary || { skipped: true };
    }

    await updateJobStage(ctx.jobId, ctx.agencyId, 'domainPrep', {
        status: 'running',
        startedAt: new Date().toISOString(),
        error: null
    });

    await assertJobActive(ctx.jobId, ctx.agencyId);
    await setJobActivity(ctx.jobId, ctx.agencyId, 'Running domain prep…');

    const pendingBefore = await listPendingJobDomains(ctx.jobId, 1);
    const reauditMonths = isShoppingAuditJob(job)
        ? Number(ctx.auditFeatures?.reauditMonths ?? 4)
        : null;

    const dedupeResult = await filterJobDomainsForDedupe({
        agencyId: ctx.agencyId,
        clientId: ctx.clientId,
        jobId: ctx.jobId,
        dedupeStrategy: ctx.options.dedupeStrategy || 'skip',
        reauditMonths
    });

    const domainCheckSkipped = ctx.options.skipDomainCheck === true;
    const dnsCandidateCount = dedupeResult.stats.new || pendingBefore.length;
    if (!domainCheckSkipped && dnsCandidateCount > 0) {
        await setJobActivity(
            ctx.jobId,
            ctx.agencyId,
            `Checking DNS for ${dnsCandidateCount.toLocaleString()} domains…`
        );
        await updateJobStage(ctx.jobId, ctx.agencyId, 'domainPrep', {
            progress: { stage: 'domainPrep', processed: 0, total: dnsCandidateCount }
        });
    }

    const dnsStats = domainCheckSkipped
        ? await (async () => {
            await markDnsSkippedForJob(ctx.jobId);
            return { checked: 0, live: 0, dead: 0, unknown: 0, processable: dedupeResult.stats.new };
        })()
        : await dnsFilterDomains(ctx.jobId, ctx.agencyId, async (processed, total) => {
            if (processed % 25 === 0 || processed === total) {
                await setJobActivity(
                    ctx.jobId,
                    ctx.agencyId,
                    `Checking DNS… ${processed.toLocaleString()} / ${total.toLocaleString()}`
                );
                await updateJobStage(ctx.jobId, ctx.agencyId, 'domainPrep', {
                    progress: { stage: 'domainPrep', processed, total }
                });
                const { scheduleStageReconcile } = await import('./stageReconcileScheduler.js');
                scheduleStageReconcile(ctx.jobId, ctx.agencyId);
            }
        });

    const dedupeStats = {
        skipped: dedupeResult.stats.skipped,
        existing: dedupeResult.stats.existing,
        new: dedupeResult.stats.new,
        processable: dnsStats.processable,
        domainCheckSkipped
    };

    await upsertInitialDomains(ctx);

    const cohortTotal = dnsStats.processable || pendingBefore.length;
    if (cohortTotal > 0) {
        await enrichJobDomainCohortFlags(ctx.jobId, ctx.options.columnMapping || {}, async ({ processed, total }) => {
            if (processed % 500 === 0 || processed === total) {
                await assertJobActive(ctx.jobId, ctx.agencyId);
                await setJobActivity(
                    ctx.jobId,
                    ctx.agencyId,
                    `Applying upload column rules… ${processed.toLocaleString()} / ${total.toLocaleString()}`
                );
            }
        });
    }

    const summary = {
        processable: dnsStats.processable,
        checked: dnsStats.checked,
        live: dnsStats.live,
        dead: dnsStats.dead,
        skippedExisting: dedupeStats.skipped,
        domainCheckSkipped
    };

    await pool.query(
        `UPDATE jobs SET dedupe_stats = $3::jsonb, updated_at = NOW() WHERE id = $1 AND agency_id = $2`,
        [ctx.jobId, ctx.agencyId, JSON.stringify(dedupeStats)]
    );

    const { runStageReconcile } = await import('./stageReconcileScheduler.js');
    await runStageReconcile(ctx.jobId, ctx.agencyId);

    return summary;
}

export async function listPendingDomainNames(jobId) {
    const rows = await listPendingJobDomains(jobId);
    return rows.map((r) => r.domain_normalized).filter(Boolean);
}
