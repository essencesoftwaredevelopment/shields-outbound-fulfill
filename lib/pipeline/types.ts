export type PipelineStageKey = "domainPrep" | "founders" | "emailDiscovery" | "verification" | "personalization";

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
}

export type PipelineServerEvent =
    | { type: "state"; state: PipelineJob }
    | { type: "error"; error: string };

export interface CreateJobResponse {
    jobId: string;
    job: PipelineJob;
}
