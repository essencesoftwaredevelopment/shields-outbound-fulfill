import { firestore } from '../config/firebase.js';

export const DEFAULT_PRICING = {
    stages: {
        founders: {
            serper_request_cost: 0.001,
            openai_per_million_input: 0.25,
            openai_per_million_output: 2.0
        },
        emailDiscovery: { request_cost: 0 },
        verification: { request_cost: 0 },
        personalization: {
            openai_per_million_input: 0.25,
            openai_per_million_output: 2.0
        }
    },
    currency: 'USD'
};

export async function loadPricing(uid) {
    let pricing = { ...DEFAULT_PRICING };
    try {
        // Try user-level override first
        if (uid) {
            const userPricingRef = firestore.collection('users').doc(uid).collection('config').doc('pricing');
            const snap = await userPricingRef.get();
            if (snap.exists) {
                pricing = { ...pricing, ...snap.data() };
            }
        }
        // Root-level default
        const rootPricingRef = firestore.collection('config').doc('pricing');
        const rootSnap = await rootPricingRef.get();
        if (rootSnap.exists) {
            pricing = { ...pricing, ...rootSnap.data() };
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
    return pricing;
}

export function computeJobCost(job) {
    const stageKeys = Object.keys(job.stages || {});
    const total = stageKeys.reduce((sum, key) => {
        const stage = job.stages[key];
        const fromSummary = stage?.summary && typeof stage.summary.cost === 'number' ? stage.summary.cost : 0;
        const fromProgress = stage?.progress && typeof stage.progress.cost === 'number' ? stage.progress.cost : 0;
        return sum + (fromSummary || fromProgress || 0);
    }, 0);
    job.cost = Number((total || 0).toFixed(6));
    return job.cost;
}
