"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/api/http";
import type { BoardResponse, Deal, DealPatch, DealStage, StageDeletion, StageDraft, StagePageResponse } from "./types";

export const PAGE_SIZE = 25;
const MAX_REFRESH_PAGE_SIZE = 500;

interface LoadOptions {
    /** Create deals for newly interested leads (skipped on background polls). */
    reconcile?: boolean;
    /** Deals per stage to fetch; defaults to PAGE_SIZE. */
    pageSize?: number;
}

export function useDealFlow(clientId: string) {
    const [stages, setStages] = useState<DealStage[]>([]);
    const [deals, setDeals] = useState<Deal[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [loadedOnce, setLoadedOnce] = useState(false);
    const [loadingMore, setLoadingMore] = useState<Set<number>>(new Set());
    const inflight = useRef<Promise<void> | null>(null);
    const dealsRef = useRef<Deal[]>([]);
    useEffect(() => {
        dealsRef.current = deals;
    }, [deals]);
    const base = `/api/clients/${encodeURIComponent(clientId)}/deal-flow`;

    const load = useCallback(async (options: LoadOptions = {}) => {
        if (!clientId) return;
        if (inflight.current) return inflight.current;
        const params = new URLSearchParams();
        params.set("limit", String(Math.min(options.pageSize ?? PAGE_SIZE, MAX_REFRESH_PAGE_SIZE)));
        params.set("reconcile", options.reconcile === false ? "0" : "1");
        const run = (async () => {
            try {
                const board = await apiJson<BoardResponse>(`${base}?${params.toString()}`);
                setStages(board.stages);
                setDeals(board.deals);
                setError(null);
            } catch (err) {
                setError(err instanceof Error ? err.message : "Failed to load deal flow.");
            } finally {
                setLoading(false);
                setLoadedOnce(true);
                inflight.current = null;
            }
        })();
        inflight.current = run;
        return run;
    }, [base, clientId]);

    /**
     * Background refresh that keeps every column at least as deep as it is now,
     * so a poll doesn't undo the user's "Load more" clicks.
     */
    const refresh = useCallback(async () => {
        const perStage = new Map<number, number>();
        for (const d of dealsRef.current) perStage.set(d.stageId, (perStage.get(d.stageId) ?? 0) + 1);
        const deepest = Math.max(PAGE_SIZE, ...perStage.values());
        return load({ reconcile: false, pageSize: deepest });
    }, [load]);

    useEffect(() => {
        setLoading(true);
        setLoadedOnce(false);
        void load({ reconcile: true });
    }, [load]);

    const loadedCount = useCallback((stageId: number) => (
        dealsRef.current.filter((d) => d.stageId === stageId).length
    ), []);

    const hasMore = useCallback((stage: DealStage) => (
        (stage.totalCount ?? 0) > deals.filter((d) => d.stageId === stage.id).length
    ), [deals]);

    const loadMore = useCallback(async (stageId: number) => {
        const column = dealsRef.current
            .filter((d) => d.stageId === stageId)
            .sort((a, b) => b.position - a.position || b.id - a.id);
        const last = column.at(-1);
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        if (last) params.set("beforeId", String(last.id));
        setLoadingMore((prev) => new Set(prev).add(stageId));
        try {
            const page = await apiJson<StagePageResponse>(`${base}/stages/${stageId}/deals?${params.toString()}`);
            setDeals((prev) => {
                const seen = new Set(prev.map((d) => d.id));
                return [...prev, ...page.deals.filter((d) => !seen.has(d.id))];
            });
            // remaining = rows older than the cursor (this page included), so
            // loaded-before-this-page + remaining is the exact total.
            const total = column.length + page.remaining;
            setStages((prev) => prev.map((s) => (s.id === stageId ? { ...s, totalCount: total } : s)));
        } finally {
            setLoadingMore((prev) => {
                const next = new Set(prev);
                next.delete(stageId);
                return next;
            });
        }
    }, [base]);

    const bumpCounts = useCallback((fromStageId: number | null, toStageId: number | null) => {
        if (fromStageId === toStageId) return;
        setStages((prev) => prev.map((s) => {
            if (s.id === fromStageId) return { ...s, totalCount: Math.max(0, (s.totalCount ?? 1) - 1) };
            if (s.id === toStageId) return { ...s, totalCount: (s.totalCount ?? 0) + 1 };
            return s;
        }));
    }, []);

    /** Apply a patch optimistically; on failure restore `snapshot` (or the pre-patch state). */
    const patchDeal = useCallback(async (dealId: number, patch: DealPatch, snapshot?: Deal[]) => {
        let before: Deal[] = [];
        let fromStageId: number | null = null;
        setDeals((prev) => {
            before = prev;
            fromStageId = prev.find((d) => d.id === dealId)?.stageId ?? null;
            return prev.map((d) => (d.id === dealId ? applyPatchLocally(d, patch) : d));
        });
        const originalStageId = (snapshot ?? before).find((d) => d.id === dealId)?.stageId ?? fromStageId;
        const stageChanged = patch.stageId !== undefined && originalStageId !== null && patch.stageId !== originalStageId;
        if (stageChanged) bumpCounts(originalStageId, patch.stageId ?? null);
        try {
            const { deal } = await apiJson<{ deal: Deal }>(`${base}/deals/${dealId}`, {
                method: "PATCH",
                body: JSON.stringify(patch),
            });
            setDeals((prev) => prev.map((d) => (d.id === dealId ? deal : d)));
            return deal;
        } catch (err) {
            setDeals(snapshot ?? before);
            if (stageChanged) bumpCounts(patch.stageId ?? null, originalStageId);
            throw err;
        }
    }, [base, bumpCounts]);

    const removeDeal = useCallback(async (dealId: number) => {
        let before: Deal[] = [];
        let stageId: number | null = null;
        setDeals((prev) => {
            before = prev;
            stageId = prev.find((d) => d.id === dealId)?.stageId ?? null;
            return prev.filter((d) => d.id !== dealId);
        });
        bumpCounts(stageId, null);
        try {
            await apiJson<{ ok: true }>(`${base}/deals/${dealId}`, { method: "DELETE" });
        } catch (err) {
            setDeals(before);
            bumpCounts(null, stageId);
            throw err;
        }
    }, [base, bumpCounts]);

    const saveStages = useCallback(async (drafts: StageDraft[], deletions: StageDeletion[]) => {
        const { stages: next } = await apiJson<{ stages: DealStage[] }>(`${base}/stages`, {
            method: "PUT",
            body: JSON.stringify({
                stages: drafts.map((s) => ({
                    id: s.id,
                    name: s.name,
                    kind: s.kind,
                    color: s.color,
                    isEntry: s.isEntry,
                })),
                deletions,
            }),
        });
        setStages(next);
        await load({ reconcile: false });
        return next;
    }, [base, load]);

    return {
        stages, deals, loading, loadedOnce, error, loadingMore,
        load, refresh, loadMore, hasMore, loadedCount,
        setDeals, patchDeal, removeDeal, saveStages,
    };
}

function applyPatchLocally(deal: Deal, patch: DealPatch): Deal {
    const next: Deal = { ...deal };
    if (patch.stageId !== undefined && patch.stageId !== deal.stageId) {
        next.stageId = patch.stageId;
        next.stageChangedAt = new Date().toISOString();
    }
    if (patch.position !== undefined) next.position = patch.position;
    if (patch.notes !== undefined) next.notes = patch.notes ?? "";
    if (patch.nextActionAt !== undefined) next.nextActionAt = patch.nextActionAt;
    return next;
}
