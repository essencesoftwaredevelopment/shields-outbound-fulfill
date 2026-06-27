import fs from 'fs';
import os from 'os';
import path from 'path';
import { runEmailFinder } from '../../services/emailFinder.js';
import { getEmailFindQueue } from '../../services/db/jobs.js';
import { upsertLeadRowsBatch } from '../../services/leads.js';
import { assertJobActive, updateJobStage, setJobActivity } from '../persist.js';
import { createRateLimitHooks } from '../rateLimit.js';
import { contextToJob } from '../context.js';

function enrichmentMergeMode(ctx) {
    return String(ctx.options.dedupeStrategy || 'skip').toLowerCase() === 'include'
        ? 'enrichment_b'
        : 'preserve';
}

function filterToBatch(rows, batchDomains) {
    const batchSet = new Set(batchDomains.map((d) => d.toLowerCase()));
    return rows.filter((r) => batchSet.has(String(r.domain || '').toLowerCase()));
}

/**
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {string[]} batchDomains
 */
export async function runEmailsBatch(ctx, batchDomains) {
    if (ctx.options.skipEmailFinder) {
        await updateJobStage(ctx.jobId, ctx.agencyId, 'emailDiscovery', {
            status: 'completed',
            completedAt: new Date().toISOString(),
            summary: { skipped: true }
        });
        return { skipped: true };
    }

    const reprocessInclude = enrichmentMergeMode(ctx) === 'enrichment_b';
    const queue = filterToBatch(
        await getEmailFindQueue(ctx.agencyId, ctx.clientId, ctx.jobId, {
            reprocessInclude,
            limit: batchDomains.length + 500
        }),
        batchDomains
    );

    if (!queue.length) {
        return { processed: 0 };
    }

    await updateJobStage(ctx.jobId, ctx.agencyId, 'emailDiscovery', {
        status: 'running',
        startedAt: new Date().toISOString()
    });
    await setJobActivity(ctx.jobId, ctx.agencyId, `Email discovery (${queue.length} founders)…`);

    const founders = queue.map((r) => ({
        domain: r.domain,
        founder_name: r.founder_name
    }));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `emails-${ctx.jobId}-`));
    const outputCsv = path.join(tmpDir, 'emails.csv');
    const job = contextToJob(ctx);

    const summary = await runEmailFinder({
        founders: founders,
        outputCsv,
        apiKeys: { ...ctx.apiKeys, kitt: ctx.apiKeys.trykitt },
        log: (msg) => console.log(`[${ctx.jobId}] [emails] ${msg}`),
        job,
        checkpoint: () => assertJobActive(ctx.jobId, ctx.agencyId),
        checkPaused: () => assertJobActive(ctx.jobId, ctx.agencyId),
        pricing: ctx.pricing,
        rateLimitHooks: createRateLimitHooks(ctx),
        onBatch: async (rows) => {
            if (!rows?.length) return;
            await upsertLeadRowsBatch({
                agencyId: ctx.agencyId,
                clientId: ctx.clientId,
                rows,
                type: 'emails',
                jobId: ctx.jobId,
                mergeMode: enrichmentMergeMode(ctx)
            });
        }
    });

    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
        // ignore
    }

    await updateJobStage(ctx.jobId, ctx.agencyId, 'emailDiscovery', {
        status: 'completed',
        completedAt: new Date().toISOString(),
        summary
    });

    return summary;
}
