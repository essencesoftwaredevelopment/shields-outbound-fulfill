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
import { pool } from '../../config/db.js';

function resolveShoppingBatchSize(batchOpts = {}) {
    if (typeof batchOpts.batchSize === 'number' && batchOpts.batchSize > 0) {
        return batchOpts.batchSize;
    }
    const fromEnv = Number.parseInt(process.env.SHOPPING_AUDIT_BATCH_SIZE || '', 10);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 25;
}

function makeStageHooks(ctx, stageKey, batchOpts = {}) {
    const batchIndex = batchOpts.batchIndex ?? 0;
    const jobTotal = resolveJobTotal(ctx) ?? batchOpts.batchSize ?? 0;
    const progressOffset = batchProgressOffset(
        batchIndex,
        ctx.pipelineMode === 'shopping_audit' ? resolveShoppingBatchSize(batchOpts) : undefined
    );
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
                // Parallel child batches each finish their own slice — do not mark the
                // job-level stage completed until cumulative processed covers jobTotal.
                // (False "completed" at 625/1000 hid hung later waves.)
                await persistStageProgress(ctx.jobId, ctx.agencyId, key, {
                    status: 'running',
                    summary,
                    error: null
                });
                const { rows } = await pool.query(
                    `SELECT stages->$3 AS stage FROM jobs WHERE id = $1 AND agency_id = $2`,
                    [ctx.jobId, ctx.agencyId, key]
                );
                const mergedSummary = rows[0]?.stage?.summary || summary || {};
                const processed = Number(mergedSummary.processed ?? 0);
                if (jobTotal > 0 && processed >= jobTotal) {
                    await persistStageProgress(ctx.jobId, ctx.agencyId, key, {
                        status: 'completed',
                        completedAt: new Date().toISOString(),
                        error: null
                    });
                }
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
    const progressOffset = batchProgressOffset(
        batchIndex,
        ctx.pipelineMode === 'shopping_audit' ? resolveShoppingBatchSize(batchOpts) : undefined
    );

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
        enableBrokenPage: process.env.SHOPPING_AUDIT_BROKEN_PAGE !== 'false',
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
        enableBrokenPage: process.env.SHOPPING_AUDIT_BROKEN_PAGE !== 'false',
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
