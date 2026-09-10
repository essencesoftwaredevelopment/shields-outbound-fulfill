"use client";

import { useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase/client";
import { debounceFn } from "@/lib/hooks/useJobRealtime";

type UseAnalyticsRealtimeArgs = {
  clientSqlId: number | null;
  enabled?: boolean;
  onEventsChange: () => void;
  onDraftsChange: () => void;
  onError?: (message: string | null) => void;
};

/**
 * Live Analytics updates via the signed-in user's Supabase session.
 * RLS (current_agency_id) scopes rows to the tenant; the channel filter
 * pins the open client.
 */
export function useAnalyticsRealtime({
  clientSqlId,
  enabled = true,
  onEventsChange,
  onDraftsChange,
  onError,
}: UseAnalyticsRealtimeArgs) {
  const onEventsRef = useRef(onEventsChange);
  const onDraftsRef = useRef(onDraftsChange);
  const onErrorRef = useRef(onError);
  onEventsRef.current = onEventsChange;
  onDraftsRef.current = onDraftsChange;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled || !clientSqlId) return;

    const notifyEvents = debounceFn(() => onEventsRef.current(), 250);
    const notifyDrafts = debounceFn(() => onDraftsRef.current(), 250);

    const channel = supabase
      .channel(`analytics-client-${clientSqlId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "contact_instantly_events",
          filter: `client_id=eq.${clientSqlId}`,
        },
        notifyEvents
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "interested_autoresponder_drafts",
          filter: `client_id=eq.${clientSqlId}`,
        },
        notifyDrafts
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          onErrorRef.current?.(null);
          return;
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          onErrorRef.current?.("Supabase Realtime channel error.");
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [clientSqlId, enabled]);
}
