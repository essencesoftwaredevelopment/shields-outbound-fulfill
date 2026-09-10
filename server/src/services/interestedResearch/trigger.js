/**
 * Express → Next.js trigger for the interested-reply research workflow.
 * Mirrors server/src/enrichment/trigger.js: the Instantly webhook / sync path
 * stays on PM2 and only fires an HTTP request; the durable research run
 * executes on the Vercel Workflows runtime.
 *
 * WORKFLOW_START_URL overrides APP_URL so local Express can hit local Next
 * (`npm run dev:all`) while APP_URL stays the public review host.
 */

export function isInterestedResearchWorkflowConfigured() {
    if (String(process.env.INTERESTED_RESEARCH_WORKFLOW_DISABLED || '').toLowerCase() === 'true') {
        return false;
    }
    return Boolean(String(process.env.WORKFLOW_TRIGGER_SECRET || '').trim());
}

export function resolveWorkflowStartBaseUrl(env = process.env) {
    const explicit = String(env.WORKFLOW_START_URL || '').trim();
    const fallback = (
        env.APP_URL
        || env.NEXT_PUBLIC_APP_URL
        || (env.VERCEL_URL ? `https://${env.VERCEL_URL}` : '')
        || 'http://localhost:3000'
    );
    return String(explicit || fallback).replace(/\/$/, '');
}

export async function triggerInterestedResearchWorkflow({
    draftId,
    agencyId,
    isFollowUp = false,
    skipNtfy = false,
    additionalInstructions = null
}) {
    const baseUrl = resolveWorkflowStartBaseUrl();

    const secret = process.env.WORKFLOW_TRIGGER_SECRET;
    if (!secret) {
        throw new Error('WORKFLOW_TRIGGER_SECRET is required to start the interested-research workflow');
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
    console.info(`[interested-research] triggering draft=${draftId} via ${host}`);

    const res = await fetch(`${baseUrl}/internal/interested-research/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            draftId,
            agencyId,
            isFollowUp,
            skipNtfy: Boolean(skipNtfy),
            additionalInstructions: additionalInstructions || null
        })
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Interested-research workflow trigger failed (${res.status}): ${text || res.statusText}`);
    }

    return res.json();
}
