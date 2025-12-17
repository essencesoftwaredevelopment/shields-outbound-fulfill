export type PipelineStageKey = "founders" | "emailDiscovery" | "verification" | "personalization";

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
    status: "queued" | "running" | "completed" | "pending-upload" | "uploaded" | "discarded" | "error" | "cancelled";
    error: string | null;
    fileName: string;
    createdAt: string;
    completedAt: string | null;
    stages: Record<PipelineStageKey, PipelineStageState>;
    dedupeStats?: { total: number; skipped: number; new: number } | null;
}

export interface PipelineLogEntry {
    message: string | null;
    meta?: Record<string, unknown>;
    timestamp: string;
}

export type PipelineServerEvent =
    | { type: "state"; state: PipelineJob }
    | { type: "log"; log: PipelineLogEntry }
    | { type: "error"; error: string };

export interface CreateJobResponse {
    jobId: string;
    job: PipelineJob;
}
