"use client";

import { useEffect, useMemo, useState } from "react";
import { STAGE_COLORS, type DealStage, type StageDeletion, type StageDraft, type StageKind } from "./types";

interface StageSettingsDialogProps {
    stages: DealStage[];
    onClose: () => void;
    onSave: (drafts: StageDraft[], deletions: StageDeletion[]) => Promise<unknown>;
}

let localKeyCounter = 0;
function nextLocalKey() {
    localKeyCounter += 1;
    return `new-${localKeyCounter}`;
}

function toDrafts(stages: DealStage[]): StageDraft[] {
    return stages.map((s) => ({
        id: s.id,
        localKey: `id-${s.id}`,
        name: s.name,
        kind: s.kind,
        color: s.color,
        isEntry: s.isEntry,
        totalCount: s.totalCount ?? 0,
    }));
}

export function StageSettingsDialog({ stages, onClose, onSave }: StageSettingsDialogProps) {
    const [drafts, setDrafts] = useState<StageDraft[]>(() => toDrafts(stages));
    // stageId → moveDealsTo stageId
    const [deletions, setDeletions] = useState<Map<number, number>>(new Map());
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const kept = useMemo(() => drafts.filter((d) => d.id === null || !deletions.has(d.id)), [drafts, deletions]);
    const moveTargets = useMemo(() => kept.filter((d) => d.id !== null), [kept]);

    function update(localKey: string, patch: Partial<StageDraft>) {
        setDrafts((prev) => prev.map((d) => (d.localKey === localKey ? { ...d, ...patch } : d)));
    }

    function setEntry(localKey: string) {
        setDrafts((prev) => prev.map((d) => ({ ...d, isEntry: d.localKey === localKey })));
    }

    function move(localKey: string, delta: -1 | 1) {
        setDrafts((prev) => {
            const index = prev.findIndex((d) => d.localKey === localKey);
            const target = index + delta;
            if (index < 0 || target < 0 || target >= prev.length) return prev;
            const next = [...prev];
            [next[index], next[target]] = [next[target], next[index]];
            return next;
        });
    }

    function addStage() {
        setDrafts((prev) => [
            ...prev,
            { id: null, localKey: nextLocalKey(), name: "", kind: "open", color: "slate", isEntry: false, totalCount: 0 },
        ]);
    }

    function remove(draft: StageDraft) {
        if (draft.id === null) {
            setDrafts((prev) => prev.filter((d) => d.localKey !== draft.localKey));
            return;
        }
        const fallback = moveTargets.find((d) => d.id !== draft.id && d.isEntry) ?? moveTargets.find((d) => d.id !== draft.id);
        if (!fallback || fallback.id === null) {
            setError("You need at least one other stage to move deals into.");
            return;
        }
        setDeletions((prev) => new Map(prev).set(draft.id as number, fallback.id as number));
        if (draft.isEntry) {
            setDrafts((prev) => prev.map((d) => ({ ...d, isEntry: d.localKey === fallback.localKey })));
        }
    }

    function undoRemove(id: number) {
        setDeletions((prev) => {
            const next = new Map(prev);
            next.delete(id);
            return next;
        });
    }

    async function save() {
        setSaving(true);
        setError(null);
        try {
            await onSave(
                kept,
                Array.from(deletions.entries()).map(([id, moveDealsTo]) => ({ id, moveDealsTo }))
            );
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Could not save stages.");
        } finally {
            setSaving(false);
        }
    }

    const hasWon = kept.some((d) => d.kind === "won");
    const hasLost = kept.some((d) => d.kind === "lost");
    const hasEntry = kept.filter((d) => d.isEntry).length === 1;
    const allNamed = kept.every((d) => d.name.trim().length > 0);
    const valid = hasWon && hasLost && hasEntry && allNamed && kept.length > 0;

    return (
        <>
            <div className="df-sheet__backdrop" onClick={onClose} aria-hidden="true" />
            <div className="df-dialog" role="dialog" aria-modal="true" aria-label="Edit stages">
                <div className="df-dialog__head">
                    <div>
                        <div className="df-dialog__title">Stages</div>
                        <div className="df-hint">Reorder, rename, recolour. New interested leads land in the entry stage. Keep at least one Won and one Lost stage.</div>
                    </div>
                    <button type="button" className="df-sheet__close" onClick={onClose} aria-label="Close">×</button>
                </div>

                <div className="df-dialog__body">
                    {drafts.map((draft, index) => {
                        const pendingDelete = draft.id !== null && deletions.has(draft.id);
                        return (
                            <div key={draft.localKey} className={`df-stage-row${pendingDelete ? " df-stage-row--deleted" : ""}`}>
                                <div className="df-stage-row__order">
                                    <button type="button" className="df-iconbtn" onClick={() => move(draft.localKey, -1)} disabled={index === 0 || saving} aria-label="Move up">↑</button>
                                    <button type="button" className="df-iconbtn" onClick={() => move(draft.localKey, 1)} disabled={index === drafts.length - 1 || saving} aria-label="Move down">↓</button>
                                </div>
                                {pendingDelete ? (
                                    <div className="df-stage-row__delete">
                                        <span>
                                            Delete <b>{draft.name}</b>
                                            {draft.totalCount > 0 && (
                                                <>
                                                    {" "}and move its {draft.totalCount} deal{draft.totalCount === 1 ? "" : "s"} to{" "}
                                                    <select
                                                        className="df-select df-select--inline"
                                                        value={deletions.get(draft.id as number)}
                                                        onChange={(event) => setDeletions((prev) => new Map(prev).set(draft.id as number, Number(event.target.value)))}
                                                    >
                                                        {moveTargets.filter((t) => t.id !== draft.id).map((t) => (
                                                            <option key={t.localKey} value={t.id as number}>{t.name || "(unnamed)"}</option>
                                                        ))}
                                                    </select>
                                                </>
                                            )}
                                        </span>
                                        <button type="button" className="df-btn df-btn--ghost" onClick={() => undoRemove(draft.id as number)}>Undo</button>
                                    </div>
                                ) : (
                                    <>
                                        <div className="df-swatches" role="radiogroup" aria-label="Colour">
                                            {STAGE_COLORS.map((color) => (
                                                <button
                                                    key={color}
                                                    type="button"
                                                    role="radio"
                                                    aria-checked={draft.color === color}
                                                    aria-label={color}
                                                    className={`df-swatch df-swatch--${color}${draft.color === color ? " df-swatch--on" : ""}`}
                                                    onClick={() => update(draft.localKey, { color })}
                                                    disabled={saving}
                                                />
                                            ))}
                                        </div>
                                        <input
                                            className="df-input df-stage-row__name"
                                            value={draft.name}
                                            placeholder="Stage name"
                                            onChange={(event) => update(draft.localKey, { name: event.target.value })}
                                            disabled={saving}
                                            aria-label="Stage name"
                                        />
                                        <select
                                            className="df-select"
                                            value={draft.kind}
                                            onChange={(event) => update(draft.localKey, { kind: event.target.value as StageKind })}
                                            disabled={saving}
                                            aria-label="Stage type"
                                        >
                                            <option value="open">Open</option>
                                            <option value="won">Won</option>
                                            <option value="lost">Lost</option>
                                        </select>
                                        <label className="df-stage-row__entry" title="New interested leads land here">
                                            <input
                                                type="radio"
                                                name="df-entry"
                                                checked={draft.isEntry}
                                                onChange={() => setEntry(draft.localKey)}
                                                disabled={saving}
                                            />
                                            Entry
                                        </label>
                                        <span className="df-stage-row__count" title="Deals in this stage">{draft.totalCount}</span>
                                        <button
                                            type="button"
                                            className="df-iconbtn"
                                            onClick={() => remove(draft)}
                                            disabled={saving}
                                            aria-label={`Delete ${draft.name || "stage"}`}
                                            title="Delete"
                                        >
                                            ×
                                        </button>
                                    </>
                                )}
                            </div>
                        );
                    })}
                    <button type="button" className="df-btn df-btn--ghost" onClick={addStage} disabled={saving}>+ Add stage</button>
                </div>

                {!valid && (
                    <div className="df-hint df-dialog__validation">
                        {!allNamed && "Every stage needs a name. "}
                        {!hasEntry && "Pick exactly one entry stage. "}
                        {!hasWon && "Keep at least one Won stage. "}
                        {!hasLost && "Keep at least one Lost stage. "}
                    </div>
                )}
                {error && <div className="df-error">{error}</div>}

                <div className="df-dialog__actions">
                    <button type="button" className="df-btn" onClick={onClose} disabled={saving}>Cancel</button>
                    <button type="button" className="df-btn df-btn--primary" onClick={() => void save()} disabled={!valid || saving}>
                        {saving ? "Saving…" : "Save stages"}
                    </button>
                </div>
            </div>
        </>
    );
}
