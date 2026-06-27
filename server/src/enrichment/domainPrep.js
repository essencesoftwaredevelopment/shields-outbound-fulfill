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

const DNS_QUERY_TIMEOUT_MS = 2500;
const DNS_CHECK_CONCURRENCY = 25;
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

async function dnsFilterDomains(jobId, agencyId, onProgress) {
    const pending = await listPendingJobDomains(jobId);
    const uniqueDomains = pending.map((r) => r.domain_normalized);
    if (!uniqueDomains.length) {
        return { checked: 0, live: 0, dead: 0, unknown: 0, processable: 0 };
    }

    let completed = 0;
    const checks = await mapWithConcurrency(
        uniqueDomains,
        DNS_CHECK_CONCURRENCY,
        async (domain) => {
            await assertJobActive(jobId, agencyId);
            const result = await checkDomainDns(domain);
            completed += 1;
            if (onProgress) onProgress(completed, uniqueDomains.length);
            return result;
        }
    );

    let live = 0;
    let dead = 0;
    let unknown = 0;
    const deadDomains = [];
    for (const result of checks) {
        if (result?.status === 'live') live += 1;
        else if (result?.status === 'dead') {
            dead += 1;
            if (result.domain) deadDomains.push(result.domain);
        } else unknown += 1;
    }

    if (deadDomains.length) {
        await pool.query(
            `UPDATE job_domains SET status = 'skipped', updated_at = NOW()
             WHERE job_id = $1 AND domain_normalized = ANY($2::text[])`,
            [jobId, deadDomains]
        );
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
    const dnsStats = domainCheckSkipped
        ? { checked: 0, live: 0, dead: 0, unknown: 0, processable: dedupeResult.stats.new }
        : await dnsFilterDomains(ctx.jobId, ctx.agencyId, async (processed, total) => {
            if (processed % 50 === 0 || processed === total) {
                await setJobActivity(
                    ctx.jobId,
                    ctx.agencyId,
                    `Checking DNS… ${processed.toLocaleString()} / ${total.toLocaleString()}`
                );
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

    await updateJobStage(ctx.jobId, ctx.agencyId, 'domainPrep', {
        status: 'completed',
        completedAt: new Date().toISOString(),
        summary,
        progress: { stage: 'domainPrep', processed: dnsStats.processable, total: cohortTotal }
    });

    await pool.query(
        `UPDATE jobs SET dedupe_stats = $3::jsonb, updated_at = NOW() WHERE id = $1 AND agency_id = $2`,
        [ctx.jobId, ctx.agencyId, JSON.stringify(dedupeStats)]
    );

    return summary;
}

export async function listPendingDomainNames(jobId) {
    const rows = await listPendingJobDomains(jobId);
    return rows.map((r) => r.domain_normalized).filter(Boolean);
}
