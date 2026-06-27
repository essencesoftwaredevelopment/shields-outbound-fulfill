import { agencyFeaturesFromSettings } from '../services/db/agencySettings.js';

/** @typedef {'pm2' | 'vercel'} ExecutionRunner */

/**
 * Resolve which runner should execute enrichment for a job.
 * Default pm2 — prod-safe until explicit cutover.
 *
 * @param {Object} params
 * @param {Object} [params.settings] agency_settings row
 * @param {Object} [params.jobOptions] jobs.options
 * @returns {ExecutionRunner}
 */
export function resolveExecutionRunner({ settings = null, jobOptions = {} } = {}) {
    if (jobOptions.executionRunner === 'vercel' || jobOptions.executionRunner === 'pm2') {
        return jobOptions.executionRunner;
    }

    const envDefault = String(process.env.ENRICHMENT_RUNNER || '').toLowerCase();
    if (envDefault === 'vercel') return 'vercel';

    const features = agencyFeaturesFromSettings(settings);
    if (features.enrichmentRunner === 'vercel') return 'vercel';

    return 'pm2';
}

export function withExecutionRunner(payload, runner) {
    return { ...payload, executionRunner: runner };
}
