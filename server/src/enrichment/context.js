/**
 * Shared enrichment context for PM2 and Vercel Workflow runners.
 * Tenant identity is always explicit — never inferred from ambient state.
 */

/** @typedef {'pm2' | 'vercel'} ExecutionRunner */

/**
 * @typedef {Object} EnrichmentContext
 * @property {string} jobId
 * @property {string} agencyId
 * @property {number} clientId
 * @property {string} clientSlug
 * @property {'shopping_audit' | 'standard'} pipelineMode
 * @property {{ openai: string, serper: string, trykitt?: string }} apiKeys
 * @property {Object} options
 * @property {Object} [auditFeatures]
 * @property {Object} [stages]
 * @property {Object} [pricing]
 */

export function contextToJob(ctx, extras = {}) {
    const opts = ctx.options || {};
    return {
        id: ctx.jobId,
        uid: ctx.agencyId,
        sqlClientId: ctx.clientId,
        clientId: ctx.clientSlug,
        apiKeys: ctx.apiKeys,
        pipelineMode: ctx.pipelineMode,
        stages: extras.stages || ctx.stages || {},
        pricing: extras.pricing || ctx.pricing || null,
        auditFeatures: ctx.auditFeatures || {},
        signalByDomain: extras.signalByDomain || null,
        dedupeStrategy: opts.dedupeStrategy || 'skip',
        skipFounderFinder: !!opts.skipFounderFinder,
        skipEmailFinder: !!opts.skipEmailFinder,
        skipVerification: !!opts.skipVerification,
        skipDomainCheck: !!opts.skipDomainCheck,
        findFounder: opts.findFounder !== false,
        industry: opts.industry || opts.nicheId || null,
        nicheId: opts.nicheId || null,
        nicheLabel: opts.nicheLabel || null,
        personalizeFirstLine: !!opts.personalizeFirstLine,
        productPromptVersion: opts.productPromptVersion || 'old',
        productPromptProducts: opts.productPromptProducts ?? 3,
        emailVerificationProvider: opts.emailVerificationProvider || 'trykitt',
        columnMapping: opts.columnMapping || { domain: 'domain', founder: '', email: '' },
        cancelled: false,
        paused: false,
        cost: extras.cost ?? 0,
        timingLog: [],
        timingTotals: {},
        ...extras
    };
}

export function jobToContext(job) {
    return {
        jobId: job.id,
        agencyId: job.uid,
        clientId: job.sqlClientId,
        clientSlug: job.clientId,
        pipelineMode: job.pipelineMode || 'standard',
        apiKeys: job.apiKeys || {},
        options: {
            dedupeStrategy: job.dedupeStrategy,
            skipFounderFinder: job.skipFounderFinder,
            skipEmailFinder: job.skipEmailFinder,
            skipVerification: job.skipVerification,
            skipDomainCheck: job.skipDomainCheck,
            findFounder: job.findFounder,
            industry: job.industry,
            nicheId: job.nicheId,
            nicheLabel: job.nicheLabel,
            personalizeFirstLine: job.personalizeFirstLine,
            productPromptVersion: job.productPromptVersion,
            productPromptProducts: job.productPromptProducts,
            emailVerificationProvider: job.emailVerificationProvider,
            columnMapping: job.columnMapping,
            executionRunner: job.executionRunner || 'pm2'
        },
        auditFeatures: job.auditFeatures,
        stages: job.stages,
        pricing: job.pricing
    };
}

export function chunkDomains(domains, size = 100) {
    const batches = [];
    for (let i = 0; i < domains.length; i += size) {
        batches.push(domains.slice(i, i + size));
    }
    return batches;
}
