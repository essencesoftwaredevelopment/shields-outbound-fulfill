import { getJobById, jobRowToState } from '../services/db/jobs.js';
import {
    getAgencySettings,
    apiKeysFromSettings,
    agencyFeaturesFromSettings,
    hasShoppingAuditFeature
} from '../services/db/agencySettings.js';
import { DEFAULT_PRICING } from '../utils/pricing.js';
import { getPricingDefaults } from '../services/db/agencySettings.js';

async function loadPricing(agencyId) {
    const settings = await getAgencySettings(agencyId);
    const defaults = await getPricingDefaults();
    const overrides = settings?.pricing_overrides || {};
    return { ...DEFAULT_PRICING, ...defaults, ...overrides };
}

/**
 * Load job + tenant API keys from Postgres. Never trust client-supplied tenant IDs
 * without verifying they match the job row.
 *
 * @param {string} jobId
 * @param {string} agencyId
 * @returns {Promise<import('./context.js').EnrichmentContext>}
 */
export async function hydrateJobContext(jobId, agencyId) {
    const row = await getJobById(jobId, agencyId);
    if (!row) {
        throw new Error(`Job ${jobId} not found for agency ${agencyId}`);
    }
    if (row.agency_id !== agencyId) {
        throw new Error('Agency mismatch for job');
    }

    const state = jobRowToState(row);
    const settings = await getAgencySettings(agencyId);
    if (!settings) {
        throw new Error(`Agency settings not found for ${agencyId}`);
    }

    const pipelineMode = state.pipelineMode || 'standard';
    if (pipelineMode === 'shopping_audit' && !hasShoppingAuditFeature(settings)) {
        throw new Error('Shopping audit pipeline is not enabled for this agency.');
    }

    const options = row.options || {};
    const pricing = await loadPricing(agencyId);

    return {
        jobId,
        agencyId,
        clientId: row.client_id,
        clientSlug: row.client_slug,
        pipelineMode,
        apiKeys: apiKeysFromSettings(settings),
        options: {
            dedupeStrategy: options.dedupeStrategy || 'skip',
            skipFounderFinder: !!options.skipFounderFinder,
            skipEmailFinder: !!options.skipEmailFinder,
            skipVerification: !!options.skipVerification,
            skipDomainCheck: !!options.skipDomainCheck,
            findFounder: options.findFounder !== false,
            industry: options.industry || null,
            nicheId: options.nicheId || null,
            nicheLabel: options.nicheLabel || null,
            personalizeFirstLine: !!options.personalizeFirstLine,
            productPromptVersion: options.productPromptVersion || 'old',
            productPromptProducts: options.productPromptProducts ?? 3,
            emailVerificationProvider: options.emailVerificationProvider || 'trykitt',
            columnMapping: options.columnMapping || { domain: 'domain', founder: '', email: '' },
            executionRunner: options.executionRunner || 'pm2',
            workflowRunId: options.workflowRunId || null
        },
        auditFeatures: agencyFeaturesFromSettings(settings),
        stages: row.stages || {},
        pricing
    };
}
