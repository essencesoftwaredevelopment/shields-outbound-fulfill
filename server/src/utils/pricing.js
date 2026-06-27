import { getAgencySettings, getPricingDefaults } from '../services/db/agencySettings.js';

export const DEFAULT_PRICING = {
    stages: {
        founders: {
            serper_request_cost: 0.001,
            openai_per_million_input: 0.25,
            openai_per_million_output: 2.0
        },
        /** Per email found (not per lookup attempt). */
        emailDiscovery: { request_cost: 0.005 },
        verification: { request_cost: 0.0015 },
        personalization: {
            openai_per_million_input: 0.25,
            openai_per_million_output: 2.0
        },
        serperShopping: { request_cost: 0.001 },
        headlessRescue: { request_cost: 0.05 }
    },
    currency: 'USD'
};

export async function loadPricing(uid) {
    let pricing = { ...DEFAULT_PRICING };
    try {
        const defaults = await getPricingDefaults();
        if (defaults && typeof defaults === 'object') {
            pricing = { ...pricing, ...defaults };
        }
        if (uid) {
            const settings = await getAgencySettings(uid);
            const overrides = settings?.pricing_overrides;
            if (overrides && typeof overrides === 'object') {
                pricing = { ...pricing, ...overrides };
            }
        }
    } catch (err) {
        console.warn('Pricing load failed, using defaults:', err?.message || err);
    }

    // Ensure nested stage defaults exist
    pricing.stages = pricing.stages || {};
    pricing.stages.founders = pricing.stages.founders || DEFAULT_PRICING.stages.founders;
    pricing.stages.emailDiscovery = pricing.stages.emailDiscovery || DEFAULT_PRICING.stages.emailDiscovery;
    pricing.stages.verification = pricing.stages.verification || DEFAULT_PRICING.stages.verification;
    pricing.stages.personalization = pricing.stages.personalization || DEFAULT_PRICING.stages.personalization;
    pricing.stages.serperShopping = pricing.stages.serperShopping || DEFAULT_PRICING.stages.serperShopping;
    pricing.stages.headlessRescue = pricing.stages.headlessRescue || DEFAULT_PRICING.stages.headlessRescue;
    return pricing;
}

/** Parse a cost field that may be a number or legacy "$1.23" string. */
export function parseCostValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const parsed = parseFloat(value.replace(/[^0-9.-]/g, ''));
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

/** Parse numeric cost from a stage summary/progress (handles legacy keys). */
export function extractStageCostAmount(stage) {
    if (!stage || typeof stage !== 'object') return 0;
    const summary = stage.summary;
    const progress = stage.progress;
    const progressStats = progress?.stats;

    const candidates = [
        summary?.cost,
        progress?.cost,
        summary?.['Estimated Cost'],
        progress?.['Estimated Cost'],
        summary?.Cost,
        progress?.Cost,
        progressStats?.cost,
        progressStats?.Cost,
    ];
    for (const value of candidates) {
        const parsed = parseCostValue(value);
        if (parsed !== null) return parsed;
    }
    return 0;
}

/** Normalize stage handler return value so computeJobCost and UI can read `cost`. */
export function normalizeStageSummary(summary) {
    if (!summary || typeof summary !== 'object') return {};
    const out = { ...summary };
    if (typeof out.cost === 'number' && Number.isFinite(out.cost)) {
        return out;
    }
    if (typeof out['Estimated Cost'] === 'number' && Number.isFinite(out['Estimated Cost'])) {
        out.cost = out['Estimated Cost'];
        return out;
    }
    if (typeof out.Cost === 'number' && Number.isFinite(out.Cost)) {
        out.cost = out.Cost;
        return out;
    }
    if (typeof out.Cost === 'string') {
        const parsed = parseFloat(String(out.Cost).replace(/[^0-9.-]/g, ''));
        if (Number.isFinite(parsed)) {
            out.cost = parsed;
        }
    }
    return out;
}

export function computeJobCost(job) {
    const stageKeys = Object.keys(job.stages || {});
    const total = stageKeys.reduce((sum, key) => sum + extractStageCostAmount(job.stages[key]), 0);
    job.cost = Number((total || 0).toFixed(6));
    return job.cost;
}
