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
    closedSinceDays: number;
    onToggleCollapse: (stageId: number) => void;
    onSelect: (deal: Deal) => void;
}

export function DealColumn({ stage, deals, collapsed, closedSinceDays, onToggleCollapse, onSelect }: DealColumnProps) {
    const { setNodeRef, isOver } = useDroppable({
        id: stageDndId(stage.id),
        data: { type: "stage", stageId: stage.id },
    });

    const total = stage.totalCount ?? deals.length;
    const isClosedKind = stage.kind !== "open";

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
                {isClosedKind && (
                    <button
                        type="button"
                        className="df-col__collapse"
                        onClick={() => onToggleCollapse(stage.id)}
                        aria-label={`Collapse ${stage.name}`}
                        title="Collapse"
                    >
                        ‹
                    </button>
                )}
            </div>
            <SortableContext items={deals.map((d) => dealDndId(d.id))} strategy={verticalListSortingStrategy}>
                <div className="df-col__body">
                    {deals.map((deal) => (
                        <DealCard key={deal.id} deal={deal} stage={stage} onSelect={onSelect} />
                    ))}
                    {deals.length === 0 && (
                        <div className="df-col__empty">
                            {isClosedKind && total > 0
                                ? `No deals closed in the last ${closedSinceDays} days`
                                : "Drop a lead here"}
                        </div>
                    )}
                </div>
            </SortableContext>
            {isClosedKind && total > deals.length && (
                <div className="df-col__foot">Showing last {closedSinceDays} days · {total} total</div>
            )}
        </div>
    );
}
