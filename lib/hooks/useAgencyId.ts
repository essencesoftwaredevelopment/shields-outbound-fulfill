"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { getAccessToken } from "@/lib/supabase/session";
import { getPipelineBaseUrl } from "@/lib/pipeline/client";

/**
 * Legacy agency_id for SQL (mapped from Supabase user via agency_auth_map).
 */
export function useAgencyId() {
    const { user, loading: authLoading } = useAuth();
    const [agencyId, setAgencyId] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (authLoading) {
            return;
        }
        if (!user) {
            setAgencyId(null);
            setLoading(false);
            return;
        }

        let cancelled = false;
        setLoading(true);

        (async () => {
            try {
                const token = await getAccessToken();
                if (!token || cancelled) {
                    return;
                }
                const response = await fetch(`${getPipelineBaseUrl()}/api/me`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!response.ok || cancelled) {
                    return;
                }
                const payload = (await response.json()) as { agencyId?: string };
                if (!cancelled && payload.agencyId) {
                    setAgencyId(payload.agencyId);
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [user?.id, authLoading]);

    return {
        agencyId,
        loading: authLoading || loading,
    };
}
