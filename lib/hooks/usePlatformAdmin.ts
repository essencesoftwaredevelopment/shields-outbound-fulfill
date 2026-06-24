"use client";

import { useEffect, useState } from "react";
import { apiJson } from "@/lib/api/http";
import { useAuth } from "@/hooks/use-auth";

export function usePlatformAdmin() {
    const { user, loading: authLoading } = useAuth();
    const [isAdmin, setIsAdmin] = useState(false);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            if (authLoading) return;
            if (!user) {
                if (!cancelled) {
                    setIsAdmin(false);
                    setLoading(false);
                }
                return;
            }
            try {
                const data = await apiJson<{ isAdmin?: boolean }>("/api/admin/me");
                if (!cancelled) {
                    setIsAdmin(!!data.isAdmin);
                }
            } catch {
                if (!cancelled) {
                    setIsAdmin(false);
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        void load();
        return () => {
            cancelled = true;
        };
    }, [user?.id, authLoading]);

    return { isAdmin, loading: authLoading || loading };
}
