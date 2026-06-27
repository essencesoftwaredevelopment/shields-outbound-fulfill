import { runShoppingAuditPipeline } from '../../services/shoppingAudit/index.js';
import { markJobDomainsSkipped } from '../../services/db/jobs.js';
import { contextToJob } from '../context.js';
import { assertJobActive, updateJobStage, setJobActivity } from '../persist.js';
import { createRateLimitHooks } from '../rateLimit.js';

function makeStageHooks(ctx, stageKey) {
    return {
        log: (message, meta) => {
            console.log(`[${ctx.jobId}] [${stageKey}] ${message}`, meta || '');
        },
        setActivity: (message) => setJobActivity(ctx.jobId, ctx.agencyId, message),
        recordTiming: () => {},
        checkpoint: () => assertJobActive(ctx.jobId, ctx.agencyId),
        updateStage: async (key, handler) => {
            await updateJobStage(ctx.jobId, ctx.agencyId, key, {
                status: 'running',
                startedAt: new Date().toISOString(),
                error: null
            });
            try {
                const summary = await handler();
                await updateJobStage(ctx.jobId, ctx.agencyId, key, {
                    status: 'completed',
                    completedAt: new Date().toISOString(),
                    summary,
                    error: null
                });
                return summary;
            } catch (err) {
                await updateJobStage(ctx.jobId, ctx.agencyId, key, {
                    status: 'error',
                    error: err?.message || String(err)
                });
                throw err;
            }
        }
    };
}

/**
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {string[]} batchDomains
 */
export async function runShoppingAuditBatch(ctx, batchDomains) {
    if (!batchDomains.length) {
        return { stats: {}, qualifiedDomains: [], skipDomains: { not_shopify: [], no_signal: [] } };
    }

    const job = contextToJob(ctx);
    const hooks = makeStageHooks(ctx, 'shoppingAudit');

    const auditResult = await runShoppingAuditPipeline({
        job,
        domains: batchDomains,
        features: ctx.auditFeatures,
        log: hooks.log,
        setActivity: hooks.setActivity,
        checkpoint: hooks.checkpoint,
        updateStage: hooks.updateStage,
        pricing: ctx.pricing,
        recordTiming: hooks.recordTiming,
        enableHeadless: false,
        enableTier2: true,
        enableBrokenPage: false,
        rateLimitHooks: createRateLimitHooks(ctx)
    });

    const toSkip = [
        ...(auditResult.skipDomains?.not_shopify || []),
        ...(auditResult.skipDomains?.no_signal || [])
    ];
    if (toSkip.length) {
        await markJobDomainsSkipped(ctx.jobId, toSkip);
        hooks.log(`Skipped ${toSkip.length} domains (not Shopify or no signal)`);
    }

    return auditResult;
}
