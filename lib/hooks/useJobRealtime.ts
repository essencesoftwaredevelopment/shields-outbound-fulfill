"use client";

import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase/client";

export function debounceFn<T extends (...args: never[]) => void>(fn: T, ms: number) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return (...args: Parameters<T>) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn(...args);
        }, ms);
    };
}

export type JobRealtimeRow = {
    id: string;
    status: string;
    paused: boolean;
    cancelled: boolean;
    stages: Record<string, unknown>;
    options?: Record<string, unknown>;
    error?: string | null;
    cost?: number;
    file_name?: string;
    dedupe_stats?: Record<string, unknown> | null;
    upload_status?: string | null;
    updated_at?: string;
};

export function rowToJobState(row: JobRealtimeRow) {
    const options = row.options || {};
    return {
        id: row.id,
        status: row.status,
        paused: row.paused,
        cancelled: row.cancelled,
        stages: row.stages || {},
        activityMessage: typeof options.activityMessage === 'string' ? options.activityMessage : null,
        activityUpdatedAt: typeof options.activityUpdatedAt === 'string' ? options.activityUpdatedAt : null,
        error: row.error ?? null,
        cost: row.cost,
        fileName: row.file_name || row.id,
        dedupeStats: row.dedupe_stats ?? null,
        createdAt: row.updated_at || new Date().toISOString(),
        completedAt: null as string | null,
    };
}

export type JobRealtimeState = ReturnType<typeof rowToJobState>;

export function useJobRealtime(
    jobId: string | null,
    onState: (state: JobRealtimeState) => void
) {
    const onStateRef = useRef(onState);
    onStateRef.current = onState;

    useEffect(() => {
        if (!jobId) return;

        let cancelled = false;
        void supabase
            .from("jobs")
            .select(
                "id, status, paused, cancelled, stages, options, error, cost, file_name, dedupe_stats, upload_status, updated_at"
            )
            .eq("id", jobId)
            .maybeSingle()
            .then(({ data }) => {
                if (cancelled || !data?.id) return;
                onStateRef.current(rowToJobState(data as JobRealtimeRow));
            });

        const channel = supabase
            .channel(`job-realtime-${jobId}`)
            .on(
                "postgres_changes",
                {
                    event: "UPDATE",
                    schema: "public",
                    table: "jobs",
                    filter: `id=eq.${jobId}`
                },
                (payload) => {
                    const row = payload.new as JobRealtimeRow;
                    if (row?.id) onStateRef.current(rowToJobState(row));
                }
            )
            .subscribe();

        return () => {
            cancelled = true;
            supabase.removeChannel(channel);
        };
    }, [jobId]);
}

export function useClientJobsRealtime(
    clientId: number | null,
    onJobsChange: () => void
) {
    const cbRef = useRef(onJobsChange);
    cbRef.current = onJobsChange;

    useEffect(() => {
        if (!clientId) return;

        const notify = debounceFn(() => cbRef.current(), 400);

        const channel = supabase
            .channel(`client-jobs-${clientId}`)
            .on(
                "postgres_changes",
                {
                    event: "INSERT",
                    schema: "public",
                    table: "jobs",
                    filter: `client_id=eq.${clientId}`
                },
                notify
            )
            .on(
                "postgres_changes",
                {
                    event: "UPDATE",
                    schema: "public",
                    table: "jobs",
                    filter: `client_id=eq.${clientId}`
                },
                notify
            )
            .on(
                "postgres_changes",
                {
                    event: "DELETE",
                    schema: "public",
                    table: "jobs",
                    filter: `client_id=eq.${clientId}`
                },
                notify
            )
            .subscribe();

        return () => {
            supabase.removeChannel(channel);
        };
    }, [clientId]);
}
