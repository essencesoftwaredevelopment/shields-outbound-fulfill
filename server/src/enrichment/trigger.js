/**
 * Express → Next.js workflow trigger (Vercel enrichment runner).
 */
export async function triggerEnrichmentWorkflow({ jobId, agencyId }) {
    const baseUrl = (
        process.env.APP_URL
        || process.env.NEXT_PUBLIC_APP_URL
        || process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`
        || 'http://localhost:3000'
    ).replace(/\/$/, '');

    const secret = process.env.WORKFLOW_TRIGGER_SECRET;
    if (!secret) {
        throw new Error('WORKFLOW_TRIGGER_SECRET is required to start Vercel enrichment workflows');
    }

    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`
    };

    const bypass = process.env.VERCEL_PROTECTION_BYPASS;
    if (bypass) {
        headers['x-vercel-protection-bypass'] = bypass;
    }

    const res = await fetch(`${baseUrl}/internal/enrichment/start`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jobId, agencyId })
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Workflow trigger failed (${res.status}): ${text || res.statusText}`);
    }

    return res.json();
}
