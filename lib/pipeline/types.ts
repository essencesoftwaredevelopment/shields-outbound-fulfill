export type StandardPipelineStageKey = "domainPrep" | "founders" | "emailDiscovery" | "verification" | "personalization";

/** shopifyCatalog/heroSelection only exist on jobs created before the serper-first refactor. */
export type ShoppingAuditStageKey = "shopifyCatalog" | "heroSelection" | "serperShopping" | "signalWaterfall";

export type PipelineStageKey = StandardPipelineStageKey | ShoppingAuditStageKey;

export type PipelineMode = "standard" | "shopping_audit";

/** Every stage key the UI may persist — standard + shopping audit (incl. legacy). */
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
    if (job?.pipelineMode === "standard") return false;
    // Legacy rows without pipelineMode: serperShopping is the audit marker;
    // shopifyCatalog covers pre-serper-first jobs. Ignore empty pending shells.
    const auditStage = job?.stages?.serperShopping ?? job?.stages?.shopifyCatalog;
    if (!auditStage) return false;
    if (auditStage.status && auditStage.status !== "pending") return true;
    if (auditStage.startedAt) return true;
    if (auditStage.summary && Object.keys(auditStage.summary).length > 0) return true;
    return false;
}

/** True only when a pre-serper-first job actually ran catalog/hero (not empty UI shells). */
export function isLegacyShoppingAuditJob(
    job?: Pick<PipelineJob, "stages"> | null
): boolean {
    const catalog = job?.stages?.shopifyCatalog;
    if (!catalog) return false;
    if (catalog.status && catalog.status !== "pending") return true;
    if (catalog.startedAt) return true;
    if (catalog.summary && Object.keys(catalog.summary).length > 0) return true;
    const hero = job?.stages?.heroSelection;
    if (!hero) return false;
    if (hero.status && hero.status !== "pending") return true;
    if (hero.startedAt) return true;
    if (hero.summary && Object.keys(hero.summary).length > 0) return true;
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
    skipFounderFinder?: boolean;
    skipEmailFinder?: boolean;
    skipVerification?: boolean;
    personalizeFirstLine?: boolean;
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

const STANDARD_STAGE_ORDER: PipelineStageKey[] = [
    "domainPrep",
    "founders",
    "emailDiscovery",
    "verification",
    "personalization",
];
const SHOPPING_AUDIT_STAGE_ORDER: PipelineStageKey[] = [
    "domainPrep",
    "serperShopping",
    "signalWaterfall",
    "founders",
    "emailDiscovery",
    "verification",
    "personalization",
];
const LEGACY_SHOPPING_AUDIT_STAGE_ORDER: PipelineStageKey[] = [
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

/**
 * Stage cards to show for a job — only selected / applicable enrichment steps.
 */
export function resolveVisibleStageKeys(
    job?: Pick<
        PipelineJob,
        | "pipelineMode"
        | "stages"
        | "skipFounderFinder"
        | "skipEmailFinder"
        | "skipVerification"
        | "personalizeFirstLine"
    > | null
): PipelineStageKey[] {
    const order = isShoppingAuditPipelineJob(job)
        ? isLegacyShoppingAuditJob(job)
            ? LEGACY_SHOPPING_AUDIT_STAGE_ORDER
            : SHOPPING_AUDIT_STAGE_ORDER
        : STANDARD_STAGE_ORDER;

    return order.filter((key) => {
        switch (key) {
            case "founders":
                return job?.skipFounderFinder !== true;
            case "emailDiscovery":
                return job?.skipEmailFinder !== true;
            case "verification":
                return job?.skipVerification !== true;
            case "personalization":
                return job?.personalizeFirstLine === true;
            default:
                return true;
        }
    });
}

export type PipelineServerEvent =
    | { type: "state"; state: PipelineJob }
    | { type: "error"; error: string };

export interface CreateJobResponse {
    jobId: string;
    job: PipelineJob;
}
