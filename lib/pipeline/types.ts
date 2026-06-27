export type StandardPipelineStageKey = "domainPrep" | "founders" | "emailDiscovery" | "verification" | "personalization";

export type ShoppingAuditStageKey = "shopifyCatalog" | "heroSelection" | "serperShopping" | "signalWaterfall";

export type PipelineStageKey = StandardPipelineStageKey | ShoppingAuditStageKey;

export type PipelineMode = "standard" | "shopping_audit";

/** Every stage key the UI may persist — standard + shopping audit. */
export const ALL_PIPELINE_STAGE_KEYS: PipelineStageKey[] = [
    "domainPrep",
    "shopifyCatalog",
    "heroSelection",
    "serperShopping",
    "signalWaterfall",
    "founders",
    "emailDiscovery",
    "verification",
    "personalization",
];

export function isShoppingAuditPipelineJob(
    job?: Pick<PipelineJob, "pipelineMode" | "stages"> | null
): boolean {
    if (job?.pipelineMode === "shopping_audit") return true;
    const shopifyStage = job?.stages?.shopifyCatalog;
    if (!shopifyStage) return false;
    if (shopifyStage.status && shopifyStage.status !== "pending") return true;
    if (shopifyStage.startedAt) return true;
    if (shopifyStage.summary && Object.keys(shopifyStage.summary).length > 0) return true;
    return false;
}

export type PipelineStageStatus = "pending" | "running" | "completed" | "error";

export type PipelineStageProgress = {
    stage?: PipelineStageKey;
    processed?: number;
    total?: number;
    found?: number;
    notFound?: number;
    stats?: Record<string, number>;
    [key: string]: unknown;
};

export interface PipelineStageState {
    status: PipelineStageStatus;
    startedAt: string | null;
    completedAt: string | null;
    summary: Record<string, unknown> | null;
    error: string | null;
    progress?: PipelineStageProgress | null;
}

export interface PipelineJob {
    id: string;
    status: "queued" | "running" | "failed" | "completed";
    error: string | null;
    errorStage?: PipelineStageKey | null;
    fileName: string;
    createdAt: string;
    completedAt: string | null;
    stages: Record<PipelineStageKey, PipelineStageState>;
    dedupeStats?: {
        total?: number;
        unique?: number;
        skipped?: number;
        new?: number;
        duplicatesRemoved?: number;
        duplicateRows?: number;
        dnsChecked?: number;
        dnsLive?: number;
        dnsDead?: number;
        dnsUnknown?: number;
        processable?: number;
        domainCheckSkipped?: boolean;
    } | null;
    skipDomainCheck?: boolean;
    cost?: number;
    clientId?: string;
    pipelineMode?: PipelineMode;
    // Secondary metadata - not part of primary lifecycle
    uploaded?: boolean;
    uploadedAt?: string | null;
    discarded?: boolean;
    paused?: boolean;
    /** job_queue.status — `paused` means the worker child has finished shutting down. */
    queueStatus?: string | null;
    /** True while a child process is still running this job. */
    workerActive?: boolean;
    activityMessage?: string | null;
    activityUpdatedAt?: string | null;
    timingTotals?: Record<string, { count: number; totalMs: number; totalRows: number; maxMs: number }>;
    timingLog?: Array<{
        at: string;
        label: string;
        category: string;
        ms: number;
        rows?: number;
        stage?: string;
        meta?: Record<string, unknown>;
    }>;
}

export type PipelineServerEvent =
    | { type: "state"; state: PipelineJob }
    | { type: "error"; error: string };

export interface CreateJobResponse {
    jobId: string;
    job: PipelineJob;
}
