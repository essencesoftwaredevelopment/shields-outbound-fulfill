"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { DealCard, dealDndId } from "./DealCard";
import type { Deal, DealStage } from "./types";

export function stageDndId(stageId: number) {
    return `stage-${stageId}`;
}

interface DealColumnProps {
    stage: DealStage;
    deals: Deal[];
    collapsed: boolean;
    hasMore: boolean;
    loadingMore: boolean;
    onLoadMore: (stageId: number) => void;
    onToggleCollapse: (stageId: number) => void;
    onSelect: (deal: Deal) => void;
}

export function DealColumn({ stage, deals, collapsed, hasMore, loadingMore, onLoadMore, onToggleCollapse, onSelect }: DealColumnProps) {
    const { setNodeRef, isOver } = useDroppable({
        id: stageDndId(stage.id),
        data: { type: "stage", stageId: stage.id },
    });

    const total = stage.totalCount ?? deals.length;
    const remaining = Math.max(0, total - deals.length);

    if (collapsed) {
        return (
            <div
                ref={setNodeRef}
                className={`df-col df-col--collapsed df-col--${stage.color}${isOver ? " df-col--over" : ""}`}
            >
                <button
                    type="button"
                    className="df-col__expand"
                    onClick={() => onToggleCollapse(stage.id)}
                    aria-label={`Expand ${stage.name}`}
                    title="Expand"
                >
                    <span className="df-col__dot" aria-hidden="true" />
                    <span className="df-col__vname">{stage.name}</span>
                    <span className="df-col__count">{total}</span>
                </button>
            </div>
        );
    }

    return (
        <div ref={setNodeRef} className={`df-col df-col--${stage.color}${isOver ? " df-col--over" : ""}`}>
            <div className="df-col__head">
                <span className="df-col__title">
                    <span className="df-col__dot" aria-hidden="true" />
                    <span className="df-col__name">{stage.name}</span>
                    <span className="df-col__count">{total}</span>
                </span>
                <button
                    type="button"
                    className="df-col__collapse"
                    onClick={() => onToggleCollapse(stage.id)}
                    aria-label={`Collapse ${stage.name}`}
                    title="Collapse"
                >
                    ‹
                </button>
            </div>
            <SortableContext items={deals.map((d) => dealDndId(d.id))} strategy={verticalListSortingStrategy}>
                <div className="df-col__body">
                    {deals.map((deal) => (
                        <DealCard key={deal.id} deal={deal} stage={stage} onSelect={onSelect} />
                    ))}
                    {deals.length === 0 && (
                        <div className="df-col__empty">Drop a lead here</div>
                    )}
                    {hasMore && (
                        <button
                            type="button"
                            className="df-btn df-btn--ghost df-col__more"
                            onClick={() => onLoadMore(stage.id)}
                            disabled={loadingMore}
                        >
                            {loadingMore ? "Loading…" : `Load more (${remaining} older)`}
                        </button>
                    )}
                </div>
            </SortableContext>
        </div>
    );
}
