"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";
import type { Deal, DealStage } from "./types";

export function dealDndId(dealId: number) {
    return `deal-${dealId}`;
}

export function daysSince(iso: string | null | undefined): number {
    if (!iso) return 0;
    const ms = Date.now() - new Date(iso).getTime();
    return Math.max(0, Math.floor(ms / 86_400_000));
}

export function formatDaysInStage(iso: string | null | undefined): string {
    const days = daysSince(iso);
    if (days === 0) return "today";
    if (days === 1) return "1d";
    if (days < 30) return `${days}d`;
    const months = Math.floor(days / 30);
    return months === 1 ? "1mo" : `${months}mo`;
}

export function instantlyDivergence(deal: Deal, stage: DealStage | undefined): string | null {
    const status = deal.instantly.interestStatus;
    if (status === null || !stage) return null;
    if (status < 0 && stage.kind !== "lost") {
        return humanizeLabel(deal.instantly.interestStatusLabel) || "Not interested";
    }
    return null;
}

export function humanizeLabel(label: string | null | undefined): string {
    if (!label) return "";
    return label
        .replace(/[_-]+/g, " ")
        .trim()
        .replace(/^\w/, (c) => c.toUpperCase());
}

export function isNextActionDue(deal: Deal): boolean {
    if (!deal.nextActionAt) return false;
    return new Date(deal.nextActionAt).getTime() <= Date.now();
}

interface DealCardProps {
    deal: Deal;
    stage: DealStage | undefined;
    onSelect?: (deal: Deal) => void;
    overlay?: boolean;
}

export function DealCard({ deal, stage, onSelect, overlay = false }: DealCardProps) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: dealDndId(deal.id),
        data: { type: "deal", dealId: deal.id, stageId: deal.stageId },
        disabled: overlay,
    });

    const style: CSSProperties = overlay
        ? {}
        : {
            transform: CSS.Translate.toString(transform),
            transition,
            opacity: isDragging ? 0.35 : 1,
        };

    const divergence = instantlyDivergence(deal, stage);
    const due = isNextActionDue(deal);
    const name = deal.contact.fullName || deal.contact.email || deal.company.domain || `Contact #${deal.contact.id}`;

    return (
        <div
            ref={overlay ? undefined : setNodeRef}
            style={style}
            className={`df-card${overlay ? " df-card--overlay" : ""}${isDragging ? " df-card--dragging" : ""}`}
            {...(overlay ? {} : attributes)}
            {...(overlay ? {} : listeners)}
            onClick={() => onSelect?.(deal)}
            onKeyDown={(event) => {
                if (event.key === "Enter" && onSelect) {
                    event.preventDefault();
                    onSelect(deal);
                }
            }}
            role="button"
            tabIndex={0}
            aria-label={`${name}, ${stage?.name ?? "deal"}`}
        >
            <div className="df-card__head">
                {deal.company.domain ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        className="df-card__favicon"
                        src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(deal.company.domain)}&sz=32`}
                        alt=""
                        width={16}
                        height={16}
                        loading="lazy"
                    />
                ) : (
                    <span className="df-card__favicon df-card__favicon--empty" aria-hidden="true" />
                )}
                <div className="df-card__title">
                    <div className="df-card__name">{name}</div>
                    {deal.company.domain && <div className="df-card__domain">{deal.company.domain}</div>}
                </div>
            </div>
            {deal.instantly.replySnippet && (
                <div className="df-card__snippet">“{deal.instantly.replySnippet}”</div>
            )}
            <div className="df-card__foot">
                <span className="df-card__meta">
                    {deal.campaign?.name ? <span className="df-card__campaign">{deal.campaign.name}</span> : null}
                    <span className="df-card__age" title={`In stage since ${new Date(deal.stageChangedAt).toLocaleString()}`}>
                        {formatDaysInStage(deal.stageChangedAt)}
                    </span>
                </span>
                <span className="df-card__pills">
                    {due && <span className="df-pill df-pill--sky">Due</span>}
                    {deal.draft && <span className="df-pill df-pill--violet">Draft</span>}
                    {divergence && <span className="df-pill df-pill--red" title="Instantly status differs from this stage">{divergence}</span>}
                </span>
            </div>
        </div>
    );
}
