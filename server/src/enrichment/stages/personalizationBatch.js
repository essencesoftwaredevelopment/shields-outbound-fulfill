import { getPersonalizeQueue, getJobById } from '../../services/db/jobs.js';
import { upsertLeadRowsBatch } from '../../services/leads.js';
import { runPersonalizationFromRows } from '../../services/personalization/index.js';
import { runPersonalization as runShoppingAuditPersonalization } from '../../services/personalization/strategies/shoppingAudit.js';
import { getSignalEmissionByDomain } from '../../services/shoppingAudit/db.js';
import { assertJobActive } from '../persist.js';
import { createRateLimitHooks } from '../rateLimit.js';
import {
    beginJobStage,
    finishJobStage,
    createStageLogger
} from '../stageProgress.js';

function enrichmentMergeMode(ctx) {
    return String(ctx.options.dedupeStrategy || 'skip').toLowerCase() === 'include'
        ? 'enrichment_b'
        : 'preserve';
}

function filterToBatch(rows, batchDomains) {
    const batchSet = new Set(batchDomains.map((d) => d.toLowerCase()));
    return rows.filter((r) => batchSet.has(String(r.domain || '').toLowerCase()));
}

async function buildSignalMap(ctx, domains) {
    const map = new Map();
    for (const domain of domains) {
        const row = await getSignalEmissionByDomain(ctx.jobId, domain);
        if (row) {
            map.set(domain, {
                signalId: row.id,
                signal: row,
                selection: null
            });
        }
    }
    return map;
}

/**
 * @param {import('../context.js').EnrichmentContext} ctx
 * @param {string[]} batchDomains
 * @param {{ batchIndex?: number }} [batchOpts]
 */
export async function runPersonalizationBatch(ctx, batchDomains, batchOpts = {}) {
    const batchIndex = batchOpts.batchIndex ?? 0;
    const jobRow = await getJobById(ctx.jobId, ctx.agencyId);
    const stageLog = createStageLogger(ctx, 'personalization', {
        label: 'personalization',
        batchLocalProgress: true,
        batchIndex
    });

    if (!ctx.options.personalizeFirstLine) {
        await finishJobStage(ctx, 'personalization', { skipped: true, personalized: 0 });
        return { skipped: true };
    }

    const reprocessInclude = enrichmentMergeMode(ctx) === 'enrichment_b';
    const queue = filterToBatch(
        await getPersonalizeQueue(ctx.agencyId, ctx.clientId, ctx.jobId, {
            reprocessInclude,
            requireValidEmail: reprocessInclude,
            limit: batchDomains.length + 500,
            jobStartedAt: jobRow?.created_at || null
        }),
        batchDomains
    );

    if (!queue.length) {
        await finishJobStage(ctx, 'personalization', { processed: 0, personalized: 0, cost: 0 });
        return { processed: 0 };
    }

    await beginJobStage(ctx, 'personalization', {
        activity: `Personalization (${queue.length})…`,
        batchIndex
    });

    const rows = queue.map((r) => ({
        domain: r.domain,
        founder_name: r.founder_name,
        email: r.email,
        email_status: r.email_status
    }));

    if (ctx.pipelineMode === 'shopping_audit') {
        const signalEmissionByDomain = await buildSignalMap(ctx, rows.map((r) => r.domain));
        const rateLimitHooks = createRateLimitHooks(ctx);
        const summary = await runShoppingAuditPersonalization({
            rows,
            apiKeys: ctx.apiKeys,
            log: stageLog,
            signalEmissionByDomain,
            templates: ctx.auditFeatures?.signalTemplates,
            checkpoint: () => assertJobActive(ctx.jobId, ctx.agencyId),
            rateLimitHooks,
            onBatch: async (batchRows) => {
                if (!batchRows?.length) return;
                await upsertLeadRowsBatch({
                    agencyId: ctx.agencyId,
                    clientId: ctx.clientId,
                    rows: batchRows.map((r) => ({
                        domain: r.domain,
                        first_line: r.first_line,
                        signal_emission_id: r.signal_emission_id
                    })),
                    type: 'personalization',
                    jobId: ctx.jobId,
                    mergeMode: enrichmentMergeMode(ctx)
                });
            }
        });

        await finishJobStage(ctx, 'personalization', {
            personalized: summary.processed,
            ...summary
        });
        return summary;
    }

    const summary = await runPersonalizationFromRows({
        rows,
        apiKeys: ctx.apiKeys,
        log: stageLog,
        industry: ctx.options.industry,
        nicheId: ctx.options.nicheId,
        nicheLabel: ctx.options.nicheLabel,
        productPromptVersion: ctx.options.productPromptVersion,
        productPromptProducts: ctx.options.productPromptProducts,
        checkpoint: () => assertJobActive(ctx.jobId, ctx.agencyId),
        onBatch: async (batchRows) => {
            if (!batchRows?.length) return;
            await upsertLeadRowsBatch({
                agencyId: ctx.agencyId,
                clientId: ctx.clientId,
                rows: batchRows,
                type: 'personalization',
                jobId: ctx.jobId,
                mergeMode: enrichmentMergeMode(ctx)
            });
        }
    });

    await finishJobStage(ctx, 'personalization', {
        personalized: summary.processed ?? summary.personalized ?? 0,
        ...summary
    });
    return summary;
}
