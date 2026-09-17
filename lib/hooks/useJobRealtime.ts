"use client";

import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase/client";
import { rowToJobState, type JobRealtimeRow, type JobRealtimeState } from "@/lib/pipeline/realtimeRow";

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

export { rowToJobState, type JobRealtimeRow, type JobRealtimeState };

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
