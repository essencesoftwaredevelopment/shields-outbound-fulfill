/**
 * Express → Next.js trigger for the warm-follow-up generation workflow.
 * Shares WORKFLOW_TRIGGER_SECRET / WORKFLOW_START_URL with interested-research.
 */

import {
    isInterestedResearchWorkflowConfigured,
    resolveWorkflowStartBaseUrl
} from '../interestedResearch/trigger.js';

export function isWarmFollowUpWorkflowConfigured() {
    return isInterestedResearchWorkflowConfigured();
}

export { resolveWorkflowStartBaseUrl };

export async function triggerWarmFollowUpWorkflow({ runId, agencyId }) {
    const baseUrl = resolveWorkflowStartBaseUrl();
    const secret = process.env.WORKFLOW_TRIGGER_SECRET;
    if (!secret) {
        throw new Error('WORKFLOW_TRIGGER_SECRET is required to start the warm-follow-up workflow');
    }

    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`
    };
    const bypass = process.env.VERCEL_PROTECTION_BYPASS;
    if (bypass) {
        headers['x-vercel-protection-bypass'] = bypass;
    }

    let host = baseUrl;
    try {
        host = new URL(baseUrl).host;
    } catch {
        // keep raw baseUrl in logs if it is not a valid URL
    }
    console.info(`[warm-follow-up] triggering run=${runId} via ${host}`);

    const res = await fetch(`${baseUrl}/internal/warm-follow-up/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ runId, agencyId })
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Warm-follow-up workflow trigger failed (${res.status}): ${text || res.statusText}`);
    }

    return res.json();
}
