import { CreateJobResponse } from "./types";

const DEFAULT_PIPELINE_URL = "http://localhost:4000";
const pipelineBaseUrl = (process.env.NEXT_PUBLIC_PIPELINE_URL || DEFAULT_PIPELINE_URL).replace(/\/$/, "");

async function readJsonSafely(response: Response) {
    try {
        return await response.json();
    } catch (error) {
        return null;
    }
}

export interface CreatePipelineJobOptions {
    file: File;
    idToken: string;
    clientId?: string;
    nicheId?: string;
    nicheLabel?: string;
    dedupeStrategy?: 'skip' | 'include';
    campaignId?: string;
    findFounder?: boolean;
    skipFounderFinder?: boolean;
    findEmail?: boolean;
    verifyEmail?: boolean;
    personalizeFirstLine?: boolean;
    signal?: AbortSignal;
}

export function getPipelineBaseUrl() {
    return pipelineBaseUrl;
}

export function getJobStreamUrl(jobId: string) {
    return `${pipelineBaseUrl}/api/jobs/${jobId}/stream`;
}

export function getJobResultUrl(jobId: string, scope: 'all' | 'valid' = 'all') {
    const query = scope === 'valid' ? '?scope=valid' : '';
    return `${pipelineBaseUrl}/api/jobs/${jobId}/result${query}`;
}

export async function createPipelineJob({ file, idToken, clientId, nicheId, nicheLabel, campaignId, findFounder, findEmail, verifyEmail, personalizeFirstLine, dedupeStrategy, signal }: CreatePipelineJobOptions) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("idToken", idToken);
    if (clientId) {
        formData.append("clientId", clientId);
    }
    if (nicheId) {
        formData.append("nicheId", nicheId);
    }
    if (nicheLabel) {
        formData.append("nicheLabel", nicheLabel);
    }
    if (campaignId) {
        formData.append("campaignId", campaignId);
    }
    // Processing options
    if (typeof findFounder === 'boolean') {
        formData.append("findFounder", String(findFounder));
    }
    if (typeof skipFounderFinder === 'boolean') {
        formData.append("skipFounderFinder", String(skipFounderFinder));
    }
    if (typeof findEmail === 'boolean') {
        formData.append("findEmail", String(findEmail));
    }
    if (typeof verifyEmail === 'boolean') {
        formData.append("verifyEmail", String(verifyEmail));
    }
    if (typeof personalizeFirstLine === 'boolean') {
        formData.append("personalizeFirstLine", String(personalizeFirstLine));
    }
    if (typeof dedupeStrategy === 'string') {
        formData.append("dedupeStrategy", dedupeStrategy);
    }

    const response = await fetch(`${pipelineBaseUrl}/api/jobs`, {
        method: "POST",
        body: formData,
        signal,
    });

    if (!response.ok) {
        const errorPayload = await readJsonSafely(response);
        const message = (errorPayload?.error as string | undefined) || response.statusText || "Failed to start pipeline.";
        throw new Error(message);
    }

    return (await response.json()) as CreateJobResponse;
}

export async function createClient({ idToken, name, industry, instantly_key }: { idToken: string; name: string; industry: 'ecom' | 'saas' | 'agency' | 'local'; instantly_key: string; }) {
    const response = await fetch(`${pipelineBaseUrl}/api/clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, name, industry, instantly_key }),
    });
    const payload = await readJsonSafely(response);
    if (!response.ok) {
        const message = (payload?.error as string | undefined) || response.statusText || "Failed to create client.";
        throw new Error(message);
    }
    return payload as { id: string };
}
