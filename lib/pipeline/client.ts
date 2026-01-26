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

async function fetchWithRetry(url: string, options: RequestInit, retries = 2): Promise<Response> {
    const startTime = Date.now();
    console.log(`🌐 [API] Starting request to ${url}`);
    
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, options);
            const duration = Date.now() - startTime;
            console.log(`✅ [API] Success ${url} (${duration}ms, status: ${response.status})`);
            return response;
        } catch (error: any) {
            const duration = Date.now() - startTime;
            console.error(`❌ [API] Attempt ${attempt + 1}/${retries + 1} failed for ${url} (${duration}ms):`, {
                name: error.name,
                message: error.message,
                code: error.code
            });
            
            // Retry on connection errors
            if (attempt < retries && (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.name === 'TypeError')) {
                const backoff = 1000 * (attempt + 1);
                console.warn(`🔄 [API] Retrying in ${backoff}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoff));
                continue;
            }
            
            // Better error messages for common network errors
            if (error.code === 'ECONNRESET') {
                console.error('🔥 ECONNRESET ERROR in pipeline client!');
                throw new Error('Connection was reset. Please try again.');
            }
            if (error.code === 'ECONNREFUSED') {
                throw new Error('Cannot connect to server. Is it running?');
            }
            
            console.error(`💥 [API] All attempts failed for ${url}`);
            throw error;
        }
    }
    throw new Error('Max retries exceeded');
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
    skipEmailFinder?: boolean;
    verifyEmail?: boolean;
    skipVerification?: boolean;
    personalizeFirstLine?: boolean;
    domainColumn?: string;
    founderColumn?: string;
    emailColumn?: string;
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

export async function createPipelineJob({
    file,
    idToken,
    clientId,
    nicheId,
    nicheLabel,
    campaignId,
    findFounder,
    skipFounderFinder,
    findEmail,
    skipEmailFinder,
    verifyEmail,
    skipVerification,
    personalizeFirstLine,
    domainColumn,
    founderColumn,
    emailColumn,
    dedupeStrategy,
    signal,
}: CreatePipelineJobOptions) {
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
    if (typeof skipEmailFinder === 'boolean') {
        formData.append("skipEmailFinder", String(skipEmailFinder));
    }
    if (typeof verifyEmail === 'boolean') {
        formData.append("verifyEmail", String(verifyEmail));
    }
    if (typeof skipVerification === 'boolean') {
        formData.append("skipVerification", String(skipVerification));
    }
    if (typeof personalizeFirstLine === 'boolean') {
        formData.append("personalizeFirstLine", String(personalizeFirstLine));
    }
    if (domainColumn) {
        formData.append("domainColumn", domainColumn);
    }
    if (founderColumn) {
        formData.append("founderColumn", founderColumn);
    }
    if (emailColumn) {
        formData.append("emailColumn", emailColumn);
    }
    if (typeof dedupeStrategy === 'string') {
        formData.append("dedupeStrategy", dedupeStrategy);
    }

    const response = await fetchWithRetry(`${pipelineBaseUrl}/api/jobs`, {
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
    const response = await fetchWithRetry(`${pipelineBaseUrl}/api/clients`, {
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
