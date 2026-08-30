"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    DndContext,
    DragOverlay,
    KeyboardSensor,
    PointerSensor,
    closestCorners,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragOverEvent,
    type DragStartEvent,
    type Over,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { toast } from "sonner";
import { useIntervalWhenVisible } from "@/lib/hooks/useIntervalWhenVisible";
import { DealCard, isNextActionDue } from "./DealCard";
import { DealColumn } from "./DealColumn";
import { DealDetailSheet } from "./DealDetailSheet";
import { StageSettingsDialog } from "./StageSettingsDialog";
import { useDealFlow } from "./useDealFlow";
import type { Deal, DealPatch, DealStage } from "./types";

const CLOSED_SINCE_DAYS = 60;
const POLL_MS = 60_000;
const GAP = 1000;

interface DealFlowBoardProps {
    clientId: string;
    onOpenLead?: (contactId: number, email: string) => void;
}

function sortByPosition(list: Deal[]): Deal[] {
    return [...list].sort((a, b) => a.position - b.position || a.id - b.id);
}

function positionBetween(prev: Deal | undefined, next: Deal | undefined): number {
    if (prev && next) return (prev.position + next.position) / 2;
    if (prev) return prev.position + GAP;
    if (next) return next.position - GAP;
    return GAP;
}

export function DealFlowBoard({ clientId, onOpenLead }: DealFlowBoardProps) {
    const { stages, deals, loading, loadedOnce, error, load, setDeals, patchDeal, removeDeal, saveStages } = useDealFlow(clientId);

    const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
    const [selectedDealId, setSelectedDealId] = useState<number | null>(null);
    const [stagesOpen, setStagesOpen] = useState(false);
    // Won/Lost start collapsed; the user can override per column.
    const [collapsedOverrides, setCollapsedOverrides] = useState<Map<number, boolean>>(new Map());
    const [search, setSearch] = useState("");
    const [campaignFilter, setCampaignFilter] = useState<string>("all");
    const [dueOnly, setDueOnly] = useState(false);

    const dealsRef = useRef(deals);
    useEffect(() => {
        dealsRef.current = deals;
    }, [deals]);
    const snapshotRef = useRef<Deal[] | null>(null);

    useIntervalWhenVisible(() => { void load(); }, POLL_MS, !activeDeal && !stagesOpen);

    const campaigns = useMemo(() => {
        const map = new Map<number, string>();
        for (const d of deals) if (d.campaign) map.set(d.campaign.id, d.campaign.name);
        return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
    }, [deals]);

    const filteredDeals = useMemo(() => {
        const q = search.trim().toLowerCase();
        return deals.filter((d) => {
            if (campaignFilter !== "all" && String(d.campaign?.id ?? "") !== campaignFilter) return false;
            if (dueOnly && !isNextActionDue(d)) return false;
            if (!q) return true;
            return (
                d.contact.fullName.toLowerCase().includes(q)
                || d.contact.email.toLowerCase().includes(q)
                || d.company.domain.toLowerCase().includes(q)
                || (d.campaign?.name.toLowerCase().includes(q) ?? false)
            );
        });
    }, [deals, search, campaignFilter, dueOnly]);

    const dealsByStage = useMemo(() => {
        const map = new Map<number, Deal[]>();
        for (const s of stages) map.set(s.id, []);
        for (const d of filteredDeals) map.get(d.stageId)?.push(d);
        for (const [id, list] of map) map.set(id, sortByPosition(list));
        return map;
    }, [stages, filteredDeals]);

    const stageById = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages]);
    const selectedDeal = selectedDealId === null ? null : deals.find((d) => d.id === selectedDealId) ?? null;

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
    );

    const stageIdForOver = useCallback((over: Over | null): number | null => {
        if (!over) return null;
        const data = over.data.current as { type?: string; stageId?: number; dealId?: number } | undefined;
        if (data?.type === "stage" && typeof data.stageId === "number") return data.stageId;
        if (data?.type === "deal" && typeof data.dealId === "number") {
            const deal = dealsRef.current.find((d) => d.id === data.dealId);
            return deal ? deal.stageId : null;
        }
        return null;
    }, []);

    const onDragStart = useCallback((event: DragStartEvent) => {
        const data = event.active.data.current as { dealId?: number } | undefined;
        const deal = dealsRef.current.find((d) => d.id === data?.dealId) ?? null;
        snapshotRef.current = dealsRef.current;
        setActiveDeal(deal);
        setSelectedDealId(null);
    }, []);

    const onDragOver = useCallback((event: DragOverEvent) => {
        const data = event.active.data.current as { dealId?: number } | undefined;
        const dealId = data?.dealId;
        const targetStageId = stageIdForOver(event.over);
        if (!dealId || targetStageId === null) return;
        const current = dealsRef.current.find((d) => d.id === dealId);
        if (!current || current.stageId === targetStageId) return;
        // Hovering a different column: show the card at the end of that column.
        const column = dealsRef.current.filter((d) => d.stageId === targetStageId && d.id !== dealId);
        const last = sortByPosition(column).at(-1);
        setDeals((prev) => prev.map((d) => (
            d.id === dealId ? { ...d, stageId: targetStageId, position: positionBetween(last, undefined) } : d
        )));
    }, [setDeals, stageIdForOver]);

    const onDragCancel = useCallback(() => {
        if (snapshotRef.current) setDeals(snapshotRef.current);
        snapshotRef.current = null;
        setActiveDeal(null);
    }, [setDeals]);

    const onDragEnd = useCallback((event: DragEndEvent) => {
        const snapshot = snapshotRef.current;
        snapshotRef.current = null;
        setActiveDeal(null);

        const data = event.active.data.current as { dealId?: number } | undefined;
        const dealId = data?.dealId;
        const targetStageId = stageIdForOver(event.over);
        if (!dealId || targetStageId === null || !snapshot) {
            if (snapshot) setDeals(snapshot);
            return;
        }
        const original = snapshot.find((d) => d.id === dealId);
        if (!original) return;

        const column = sortByPosition(dealsRef.current.filter((d) => d.stageId === targetStageId && d.id !== dealId));
        const overData = event.over?.data.current as { type?: string; dealId?: number } | undefined;
        let index = column.length;
        if (overData?.type === "deal" && overData.dealId !== dealId) {
            const overIndex = column.findIndex((d) => d.id === overData.dealId);
            if (overIndex >= 0) {
                const sameColumn = original.stageId === targetStageId;
                const originalIndex = sameColumn
                    ? sortByPosition(snapshot.filter((d) => d.stageId === targetStageId)).findIndex((d) => d.id === dealId)
                    : -1;
                // Moving down within the same column drops after the hovered card; otherwise before it.
                index = sameColumn && originalIndex >= 0 && originalIndex <= overIndex ? overIndex + 1 : overIndex;
            }
        }
        const position = positionBetween(column[index - 1], column[index]);

        if (original.stageId === targetStageId && Math.abs(original.position - position) < 1e-9) {
            setDeals(snapshot);
            return;
        }

        const patch: DealPatch = { position };
        if (original.stageId !== targetStageId) patch.stageId = targetStageId;
        void patchDeal(dealId, patch, snapshot).catch((err: unknown) => {
            toast.error(err instanceof Error ? err.message : "Could not move the deal.");
        });
    }, [patchDeal, setDeals, stageIdForOver]);

    const moveToStage = useCallback(async (deal: Deal, stageId: number) => {
        const column = sortByPosition(dealsRef.current.filter((d) => d.stageId === stageId && d.id !== deal.id));
        await patchDeal(deal.id, { stageId, position: positionBetween(column.at(-1), undefined) });
    }, [patchDeal]);

    const isCollapsed = useCallback((stage: DealStage) => (
        collapsedOverrides.get(stage.id) ?? stage.kind !== "open"
    ), [collapsedOverrides]);

    const toggleCollapse = useCallback((stageId: number) => {
        const stage = stageById.get(stageId);
        if (!stage) return;
        setCollapsedOverrides((prev) => {
            const next = new Map(prev);
            next.set(stageId, !(prev.get(stageId) ?? stage.kind !== "open"));
            return next;
        });
    }, [stageById]);

    const openCount = useMemo(
        () => deals.filter((d) => stageById.get(d.stageId)?.kind === "open").length,
        [deals, stageById]
    );

    if (loading && !loadedOnce) {
        return <div className="df-state">Loading deal flow…</div>;
    }
    if (error && deals.length === 0 && stages.length === 0) {
        return (
            <div className="df-state df-state--error">
                {error}
                <button type="button" className="df-btn" onClick={() => void load()} style={{ marginLeft: 12 }}>Retry</button>
            </div>
        );
    }

    return (
        <div className="df">
            <div className="df-toolbar">
                <div className="df-toolbar__left">
                    <input
                        className="df-input df-toolbar__search"
                        type="search"
                        placeholder="Search name, email, domain…"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        aria-label="Search deals"
                    />
                    {campaigns.length > 1 && (
                        <select
                            className="df-select"
                            value={campaignFilter}
                            onChange={(event) => setCampaignFilter(event.target.value)}
                            aria-label="Filter by campaign"
                        >
                            <option value="all">All campaigns</option>
                            {campaigns.map(([id, name]) => (
                                <option key={id} value={String(id)}>{name}</option>
                            ))}
                        </select>
                    )}
                    <label className="df-check">
                        <input type="checkbox" checked={dueOnly} onChange={(event) => setDueOnly(event.target.checked)} />
                        Next action due
                    </label>
                </div>
                <div className="df-toolbar__right">
                    <span className="df-hint">{openCount} open</span>
                    <button type="button" className="df-btn df-btn--ghost" onClick={() => void load()} disabled={loading} title="Refresh">
                        {loading ? "Refreshing…" : "Refresh"}
                    </button>
                    <button type="button" className="df-btn" onClick={() => setStagesOpen(true)}>Edit stages</button>
                </div>
            </div>

            {error && <div className="df-error df-error--inline">{error}</div>}

            {deals.length === 0 && (
                <div className="df-empty">
                    No interested leads yet — leads that reply <b>Interested</b> in Instantly appear here automatically.
                </div>
            )}

            <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDragEnd={onDragEnd}
                onDragCancel={onDragCancel}
            >
                <div className="df-board">
                    {stages.map((stage: DealStage) => (
                        <DealColumn
                            key={stage.id}
                            stage={stage}
                            deals={dealsByStage.get(stage.id) ?? []}
                            collapsed={isCollapsed(stage)}
                            closedSinceDays={CLOSED_SINCE_DAYS}
                            onToggleCollapse={toggleCollapse}
                            onSelect={(deal) => setSelectedDealId(deal.id)}
                        />
                    ))}
                </div>
                <DragOverlay dropAnimation={null}>
                    {activeDeal ? <DealCard deal={activeDeal} stage={stageById.get(activeDeal.stageId)} overlay /> : null}
                </DragOverlay>
            </DndContext>

            {selectedDeal && (
                <DealDetailSheet
                    deal={selectedDeal}
                    stages={stages}
                    onClose={() => setSelectedDealId(null)}
                    onPatch={(dealId, patch) => patchDeal(dealId, patch)}
                    onMoveToStage={moveToStage}
                    onRemove={removeDeal}
                    onOpenLead={onOpenLead}
                />
            )}

            {stagesOpen && (
                <StageSettingsDialog
                    stages={stages}
                    onClose={() => setStagesOpen(false)}
                    onSave={async (drafts, deletions) => {
                        await saveStages(drafts, deletions);
                        toast.success("Stages saved");
                    }}
                />
            )}
        </div>
    );
}
