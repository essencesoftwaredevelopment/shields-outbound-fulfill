"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiJson } from "@/lib/api/http";
import type { BoardResponse, Deal, DealPatch, DealStage, StageDeletion, StageDraft } from "./types";

const CLOSED_SINCE_DAYS = 60;

export function useDealFlow(clientId: string) {
    const [stages, setStages] = useState<DealStage[]>([]);
    const [deals, setDeals] = useState<Deal[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [loadedOnce, setLoadedOnce] = useState(false);
    const inflight = useRef<Promise<void> | null>(null);
    const base = `/api/clients/${encodeURIComponent(clientId)}/deal-flow`;

    const load = useCallback(async () => {
        if (!clientId) return;
        if (inflight.current) return inflight.current;
        const run = (async () => {
            try {
                const board = await apiJson<BoardResponse>(`${base}?closedSinceDays=${CLOSED_SINCE_DAYS}`);
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

    useEffect(() => {
        setLoading(true);
        setLoadedOnce(false);
        void load();
    }, [load]);

    /** Apply a patch optimistically; on failure restore `snapshot` (or the pre-patch state). */
    const patchDeal = useCallback(async (dealId: number, patch: DealPatch, snapshot?: Deal[]) => {
        let before: Deal[] = [];
        setDeals((prev) => {
            before = prev;
            return prev.map((d) => (d.id === dealId ? applyPatchLocally(d, patch) : d));
        });
        try {
            const { deal } = await apiJson<{ deal: Deal }>(`${base}/deals/${dealId}`, {
                method: "PATCH",
                body: JSON.stringify(patch),
            });
            setDeals((prev) => prev.map((d) => (d.id === dealId ? deal : d)));
            return deal;
        } catch (err) {
            setDeals(snapshot ?? before);
            throw err;
        }
    }, [base]);

    const removeDeal = useCallback(async (dealId: number) => {
        let before: Deal[] = [];
        setDeals((prev) => {
            before = prev;
            return prev.filter((d) => d.id !== dealId);
        });
        try {
            await apiJson<{ ok: true }>(`${base}/deals/${dealId}`, { method: "DELETE" });
        } catch (err) {
            setDeals(before);
            throw err;
        }
    }, [base]);

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
        await load();
        return next;
    }, [base, load]);

    return { stages, deals, loading, loadedOnce, error, load, setDeals, patchDeal, removeDeal, saveStages };
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
