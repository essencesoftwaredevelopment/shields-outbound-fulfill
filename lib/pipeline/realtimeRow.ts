import type { AutoInstantlyJobState } from "@/lib/pipeline/types";
/**
 * Realtime `jobs` row → page job state. Pure so it can be unit-tested away from
 * the Supabase client (the hook in lib/hooks/useJobRealtime.ts re-exports it).
 */
import type { JobColumnMapping } from "./types";

export type JobRealtimeRow = {
    id: string;
    status: string;
    paused: boolean;
    cancelled: boolean;
    // `stages`, `options` and `dedupe_stats` are TOASTed JSONB: Postgres logical
    // decoding leaves them out of an UPDATE record they were not part of (e.g. the
    // 30s heartbeat `SET updated_at = NOW()`), so a Realtime payload can arrive
    // without them. Treat "absent" as unknown, never as empty.
    stages?: Record<string, unknown> | null;
    options?: Record<string, unknown> | null;
    error?: string | null;
    cost?: number;
    file_name?: string;
    dedupe_stats?: Record<string, unknown> | null;
    upload_status?: string | null;
    updated_at?: string;
};

/** Upload column mapping from job options (founder / email / emailStatus → CSV header). */
export function columnMappingFromOptions(options: Record<string, unknown>): JobColumnMapping | null {
    const raw = options.columnMapping;
    if (!raw || typeof raw !== "object") return null;
    const mapping = raw as Record<string, unknown>;
    const pick = (key: string) => (typeof mapping[key] === "string" ? (mapping[key] as string).trim() : "");
    return {
        domain: pick("domain"),
        founder: pick("founder"),
        email: pick("email"),
        emailStatus: pick("emailStatus"),
    };
}

/**
 * Auto-add config + tally from job options (realtime row) or the API's
 * `autoInstantly` / `autoInstantlyStats` fields. null when the job doesn't add
 * to Instantly.
 */
export function autoInstantlyFromOptions(options: Record<string, unknown>): AutoInstantlyJobState | null {
    const config = options.autoInstantly as Record<string, unknown> | null | undefined;
    if (!config || typeof config !== "object" || !config.campaignId) return null;
    const stats = (options.autoInstantlyStats || {}) as Record<string, unknown>;
    const count = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    return {
        campaignName: typeof config.campaignName === "string" && config.campaignName ? config.campaignName : null,
        added: count(stats.added),
        failed: count(stats.failed),
        lastError: typeof stats.lastError === "string" && stats.lastError ? stats.lastError : null,
    };
}

/** Option-derived job fields; only emitted when the payload actually carried `options`. */
function optionsToJobState(options: Record<string, unknown>) {
    // Prefer explicit options.pipelineMode. Do not infer shopping_audit from stage
    // shells — get_job_stage_counts / normalizeStages can leave empty keys that
    // would falsely flip a standard DNS+verify job into the shopping-audit layout.
    const pipelineMode: "shopping_audit" | "standard" =
        options.pipelineMode === "shopping_audit"
        || options.nicheId === "shopping_audit"
        || options.industry === "shopping_audit"
            ? "shopping_audit"
            : "standard";
    return {
        pipelineMode,
        skipFounderFinder: options.skipFounderFinder === true,
        skipEmailFinder: options.skipEmailFinder === true,
        skipVerification: options.skipVerification === true,
        skipDomainCheck: options.skipDomainCheck === true,
        personalizeFirstLine: options.personalizeFirstLine === true,
        columnMapping: columnMappingFromOptions(options),
        activityMessage: typeof options.activityMessage === 'string' ? options.activityMessage : null,
        activityUpdatedAt: typeof options.activityUpdatedAt === 'string' ? options.activityUpdatedAt : null,
        autoInstantly: autoInstantlyFromOptions(options),
    };
}

/**
 * Realtime row → job state. Fields whose source column is missing from the
 * payload are left out entirely (not defaulted), so the merge in the page keeps
 * the previous value: a heartbeat UPDATE without `options` must not flip the
 * skip flags to false and un-hide the Founder/Email cards for a beat.
 */
export function rowToJobState(row: JobRealtimeRow) {
    return {
        id: row.id,
        status: row.status,
        paused: row.paused,
        cancelled: row.cancelled,
        ...(row.stages !== undefined ? { stages: row.stages || {} } : {}),
        ...(row.options !== undefined ? optionsToJobState(row.options || {}) : {}),
        ...(row.dedupe_stats !== undefined ? { dedupeStats: row.dedupe_stats ?? null } : {}),
        error: row.error ?? null,
        cost: row.cost,
        fileName: row.file_name || row.id,
        createdAt: row.updated_at || new Date().toISOString(),
        completedAt: null as string | null,
    };
}

export type JobRealtimeState = ReturnType<typeof rowToJobState>;
