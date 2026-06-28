import {
    runShoppingAuditPipeline,
    runShoppingAuditPipelineStage,
    finalizeShoppingAuditBatchState
} from '../../services/shoppingAudit/index.js';
import { markJobDomainsSkipped } from '../../services/db/jobs.js';
import { contextToJob } from '../context.js';
import { assertJobActive, setJobActivity } from '../persist.js';
import { createRateLimitHooks } from '../rateLimit.js';
import {
    createStageLogger,
    resolveJobTotal,
    batchProgressOffset,
    persistStageProgress
} from '../stageProgress.js';

function makeStageHooks(ctx, stageKey, batchOpts = {}) {
    const batchIndex = batchOpts.batchIndex ?? 0;
    const jobTotal = resolveJobTotal(ctx) ?? batchOpts.batchSize ?? 0;
    const progressOffset = batchProgressOffset(batchIndex);
    const stageLog = createStageLogger(ctx, stageKey, {
        label: stageKey,
        jobTotal,
        progressOffset
    });

    return {
        log: (message, meta) => stageLog(message, meta),
        setActivity: (message) => setJobActivity(ctx.jobId, ctx.agencyId, message),
        recordTiming: () => {},
        checkpoint: () => assertJobActive(ctx.jobId, ctx.agencyId),
        updateStage: async (key, handler) => {
            await persistStageProgress(ctx.jobId, ctx.agencyId, key, {
                status: 'running',
                startedAt: new Date().toISOString(),
                error: null
            });
            try {
                const summary = await handler();
                await persistStageProgress(ctx.jobId, ctx.agencyId, key, {
                    status: 'completed',
                    completedAt: new Date().toISOString(),
                    summary,
                    error: null
                });
                return summary;
            } catch (err) {
                await persistStageProgress(ctx.jobId, ctx.agencyId, key, {
                    status: 'error',
                    error: err?.message || String(err)
                });
                throw err;
            }
        }
    };
}

function makePipelineHooks(ctx, batchOpts = {}) {
    const batchIndex = batchOpts.batchIndex ?? 0;
    const jobTotal = resolveJobTotal(ctx) ?? batchOpts.batchSize ?? 0;
    const progressOffset = batchProgressOffset(batchIndex);

    return {
        log: (message, meta) => {
            const subStage = meta?.progress?.stage;
            const stageKey = subStage && subStage !== 'shoppingAudit' ? subStage : 'shoppingAudit';
            const subLog = createStageLogger(ctx, stageKey, {
                label: stageKey,
                jobTotal,
                progressOffset
            });
            subLog(message, meta);
        },
        setActivity: (message) => setJobActivity(ctx.jobId, ctx.agencyId, message),
        checkpoint: () => assertJobActive(ctx.jobId, ctx.agencyId),
        updateStage: (key, handler) => makeStageHooks(ctx, key, {
            batchIndex,
            batchSize: batchOpts.batchSize
        }).updateStage(key, handler),
        recordTiming: () => {},
        rateLimitHooks: createRateLimitHooks(ctx)
    };
}

/**
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {string[]} batchDomains
 * @param {{ batchIndex?: number }} [batchOpts]
 */
export async function runShoppingAuditBatch(ctx, batchDomains, batchOpts = {}) {
    if (!batchDomains.length) {
        return { stats: {}, qualifiedDomains: [], skipDomains: { not_shopify: [], no_signal: [] } };
    }

    const job = contextToJob(ctx);
    const hooks = makePipelineHooks(ctx, {
        batchIndex: batchOpts.batchIndex ?? 0,
        batchSize: batchDomains.length
    });

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
        rateLimitHooks: hooks.rateLimitHooks
    });

    await markShoppingAuditSkips(ctx, auditResult.skipDomains);
    return auditResult;
}

/**
 * One shopping-audit stage for Vercel child workflows (state passed between steps).
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {string[]} batchDomains
 * @param {'shopifyCatalog'|'heroSelection'|'serperShopping'|'signalWaterfall'} stage
 * @param {object|null} state
 * @param {{ batchIndex?: number }} [batchOpts]
 */
export async function runShoppingAuditStageBatch(
    ctx,
    batchDomains,
    stage,
    state = null,
    batchOpts = {}
) {
    if (!batchDomains.length) {
        return state;
    }

    const job = contextToJob(ctx);
    const hooks = makePipelineHooks(ctx, {
        batchIndex: batchOpts.batchIndex ?? 0,
        batchSize: batchDomains.length
    });

    return runShoppingAuditPipelineStage({
        stage,
        job,
        domains: batchDomains,
        state,
        features: ctx.auditFeatures,
        log: hooks.log,
        setActivity: hooks.setActivity,
        checkpoint: hooks.checkpoint,
        updateStage: hooks.updateStage,
        pricing: ctx.pricing,
        recordTiming: hooks.recordTiming,
        enableTier2: true,
        enableBrokenPage: false,
        rateLimitHooks: hooks.rateLimitHooks
    });
}

/**
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {object} state
 */
export async function finalizeShoppingAuditStageBatch(ctx, state) {
    const auditResult = finalizeShoppingAuditBatchState(state);
    await markShoppingAuditSkips(ctx, auditResult.skipDomains);
    return auditResult;
}

async function markShoppingAuditSkips(ctx, skipDomains) {
    const toSkip = [
        ...(skipDomains?.not_shopify || []),
        ...(skipDomains?.no_signal || [])
    ];
    if (!toSkip.length) return;

    await markJobDomainsSkipped(ctx.jobId, toSkip);
    console.log(`[${ctx.jobId}] [shoppingAudit] Skipped ${toSkip.length} domains (not Shopify or no signal)`);
}
