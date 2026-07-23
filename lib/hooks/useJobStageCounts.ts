"use client";

import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase/client";
import {
    stageCountsToStages,
    type JobStageCounts,
} from "@/lib/enrichment/stageCounts";
import type { PipelineJob, PipelineStageKey, PipelineStageState } from "@/lib/pipeline/types";

const DEFAULT_POLL_MS = 1500;

export type JobStageCountsUpdate = {
    stages: Partial<Record<PipelineStageKey, PipelineStageState>>;
    cost?: number;
    pipelineMode?: string;
};

/**
 * Poll get_job_stage_counts(job_id) while a job is active.
 * Spreadsheet progress — does not read jobs.stages for counters.
 */
export function useJobStageCounts(
    jobId: string | null,
    opts: {
        enabled?: boolean;
        intervalMs?: number;
        jobRunning?: boolean;
        jobCompleted?: boolean;
        priorStages?: Record<string, PipelineStageState> | null;
        onUpdate: (update: JobStageCountsUpdate) => void;
    }
) {
    const onUpdateRef = useRef(opts.onUpdate);
    onUpdateRef.current = opts.onUpdate;
    const priorRef = useRef(opts.priorStages);
    priorRef.current = opts.priorStages;

    const enabled = opts.enabled !== false && Boolean(jobId);
    const intervalMs = opts.intervalMs ?? DEFAULT_POLL_MS;
    const jobRunning = opts.jobRunning === true;
    const jobCompleted = opts.jobCompleted === true;

    useEffect(() => {
        if (!enabled || !jobId) return;

        let cancelled = false;

        const tick = async () => {
            const { data, error } = await supabase.rpc("get_job_stage_counts", {
                p_job_id: jobId,
            });
            if (cancelled || error || !data) {
                if (error) {
                    console.warn("[useJobStageCounts]", error.message);
                }
                return;
            }
            const counts = data as JobStageCounts;
            const stages = stageCountsToStages(counts, priorRef.current as PipelineJob["stages"], {
                jobRunning,
                jobCompleted,
            });
            onUpdateRef.current({
                stages,
                cost: typeof counts.jobCost === "number" ? Number(counts.jobCost) : undefined,
                pipelineMode: counts.pipelineMode,
            });
        };

        void tick();
        const timer = setInterval(() => {
            void tick();
        }, intervalMs);

        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [enabled, jobId, intervalMs, jobRunning, jobCompleted]);
}
