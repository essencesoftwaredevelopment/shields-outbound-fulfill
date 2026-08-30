"use client";

import { useEffect, useState } from "react";
import { formatDaysInStage, humanizeLabel, instantlyDivergence } from "./DealCard";
import type { Deal, DealPatch, DealStage } from "./types";

interface DealDetailSheetProps {
    deal: Deal;
    stages: DealStage[];
    onClose: () => void;
    onPatch: (dealId: number, patch: DealPatch) => Promise<unknown>;
    onMoveToStage: (deal: Deal, stageId: number) => Promise<unknown>;
    onRemove: (dealId: number) => Promise<unknown>;
    onOpenLead?: (contactId: number, email: string) => void;
}

function toLocalInputValue(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DealDetailSheet({ deal, stages, onClose, onPatch, onMoveToStage, onRemove, onOpenLead }: DealDetailSheetProps) {
    const [notes, setNotes] = useState(deal.notes);
    const [nextAction, setNextAction] = useState(toLocalInputValue(deal.nextActionAt));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);

    useEffect(() => {
        setNotes(deal.notes);
        setNextAction(toLocalInputValue(deal.nextActionAt));
        setConfirmRemove(false);
        setError(null);
    }, [deal.id, deal.notes, deal.nextActionAt]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const stage = stages.find((s) => s.id === deal.stageId);
    const divergence = instantlyDivergence(deal, stage);
    const dirty = notes !== deal.notes || nextAction !== toLocalInputValue(deal.nextActionAt);
    const name = deal.contact.fullName || deal.contact.email || deal.company.domain;

    async function run(action: () => Promise<unknown>) {
        setSaving(true);
        setError(null);
        try {
            await action();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Something went wrong.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <>
            <div className="df-sheet__backdrop" onClick={onClose} aria-hidden="true" />
            <aside className="df-sheet" role="dialog" aria-modal="true" aria-label={`Deal: ${name}`}>
                <div className="df-sheet__head">
                    <div className="df-sheet__identity">
                        {deal.company.domain && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                className="df-sheet__favicon"
                                src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(deal.company.domain)}&sz=64`}
                                alt=""
                                width={28}
                                height={28}
                            />
                        )}
                        <div>
                            <div className="df-sheet__name">{name}</div>
                            <div className="df-sheet__sub">
                                {deal.company.domain && (
                                    <a href={`https://${deal.company.domain}`} target="_blank" rel="noreferrer">{deal.company.domain}</a>
                                )}
                                {deal.contact.email && (
                                    <>
                                        {deal.company.domain ? " · " : ""}
                                        <a href={`mailto:${deal.contact.email}`}>{deal.contact.email}</a>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                    <button type="button" className="df-sheet__close" onClick={onClose} aria-label="Close">×</button>
                </div>

                <div className="df-sheet__body">
                    <div className="df-field">
                        <label className="df-label" htmlFor={`df-stage-${deal.id}`}>Stage</label>
                        <select
                            id={`df-stage-${deal.id}`}
                            className="df-select"
                            value={deal.stageId}
                            disabled={saving}
                            onChange={(event) => {
                                const stageId = Number(event.target.value);
                                if (stageId !== deal.stageId) void run(() => onMoveToStage(deal, stageId));
                            }}
                        >
                            {stages.map((s) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                        </select>
                        <div className="df-hint">In this stage for {formatDaysInStage(deal.stageChangedAt)}</div>
                    </div>

                    <dl className="df-facts">
                        {deal.campaign && (
                            <>
                                <dt>Campaign</dt>
                                <dd>{deal.campaign.name}</dd>
                            </>
                        )}
                        <dt>Instantly</dt>
                        <dd>
                            {deal.instantly.interestStatusLabel
                                ? humanizeLabel(deal.instantly.interestStatusLabel)
                                : "—"}
                            {divergence && <span className="df-pill df-pill--red" style={{ marginLeft: 8 }}>Differs from stage</span>}
                        </dd>
                        {deal.instantly.timestampLastReply && (
                            <>
                                <dt>Last reply</dt>
                                <dd>{new Date(deal.instantly.timestampLastReply).toLocaleString()}</dd>
                            </>
                        )}
                        <dt>Added</dt>
                        <dd>{new Date(deal.createdAt).toLocaleDateString()} · {deal.source === "manual" ? "added manually" : "from Instantly"}</dd>
                    </dl>

                    {deal.instantly.replySnippet && (
                        <div className="df-field">
                            <div className="df-label">Latest reply</div>
                            <blockquote className="df-quote">{deal.instantly.replySnippet}</blockquote>
                        </div>
                    )}

                    {deal.draft && (
                        <div className="df-notice">
                            Autoresponder draft is {humanizeLabel(deal.draft.status).toLowerCase()}.
                            {deal.draft.reviewToken && (
                                <>
                                    {" "}
                                    <a href={`/interested-autoresponder/${deal.draft.reviewToken}`} target="_blank" rel="noreferrer">Review draft ↗</a>
                                </>
                            )}
                        </div>
                    )}

                    <div className="df-field">
                        <label className="df-label" htmlFor={`df-next-${deal.id}`}>Next action</label>
                        <input
                            id={`df-next-${deal.id}`}
                            className="df-input"
                            type="datetime-local"
                            value={nextAction}
                            onChange={(event) => setNextAction(event.target.value)}
                            disabled={saving}
                        />
                    </div>

                    <div className="df-field">
                        <label className="df-label" htmlFor={`df-notes-${deal.id}`}>Notes</label>
                        <textarea
                            id={`df-notes-${deal.id}`}
                            className="df-textarea"
                            rows={6}
                            value={notes}
                            onChange={(event) => setNotes(event.target.value)}
                            disabled={saving}
                            placeholder="Context, objections, what was agreed…"
                        />
                    </div>

                    {error && <div className="df-error">{error}</div>}

                    <div className="df-sheet__actions">
                        <button
                            type="button"
                            className="df-btn df-btn--primary"
                            disabled={!dirty || saving}
                            onClick={() => void run(() => onPatch(deal.id, {
                                notes,
                                nextActionAt: nextAction ? new Date(nextAction).toISOString() : null,
                            }))}
                        >
                            {saving ? "Saving…" : "Save"}
                        </button>
                        {onOpenLead && (
                            <button
                                type="button"
                                className="df-btn"
                                onClick={() => onOpenLead(deal.contact.id, deal.contact.email)}
                            >
                                Open lead details
                            </button>
                        )}
                        <span className="df-sheet__spacer" />
                        {confirmRemove ? (
                            <span className="df-sheet__confirm">
                                Remove from board?
                                <button
                                    type="button"
                                    className="df-btn df-btn--danger"
                                    disabled={saving}
                                    onClick={() => void run(async () => { await onRemove(deal.id); onClose(); })}
                                >
                                    Remove
                                </button>
                                <button type="button" className="df-btn" onClick={() => setConfirmRemove(false)}>Keep</button>
                            </span>
                        ) : (
                            <button type="button" className="df-btn df-btn--ghost" onClick={() => setConfirmRemove(true)}>
                                Remove from board
                            </button>
                        )}
                    </div>
                </div>
            </aside>
        </>
    );
}
