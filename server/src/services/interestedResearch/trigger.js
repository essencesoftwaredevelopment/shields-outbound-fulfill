/**
 * Express → Next.js trigger for the interested-reply research workflow.
 * Mirrors server/src/enrichment/trigger.js: the Instantly webhook / sync path
 * stays on PM2 and only fires an HTTP request; the durable research run
 * executes on the Vercel Workflows runtime.
 */

export function isInterestedResearchWorkflowConfigured() {
    if (String(process.env.INTERESTED_RESEARCH_WORKFLOW_DISABLED || '').toLowerCase() === 'true') {
        return false;
    }
    return Boolean(String(process.env.WORKFLOW_TRIGGER_SECRET || '').trim());
}

export async function triggerInterestedResearchWorkflow({
    draftId,
    agencyId,
    isFollowUp = false,
    skipNtfy = false,
    additionalInstructions = null
}) {
    const baseUrl = (
        process.env.APP_URL
        || process.env.NEXT_PUBLIC_APP_URL
        || process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`
        || 'http://localhost:3000'
    ).replace(/\/$/, '');

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
