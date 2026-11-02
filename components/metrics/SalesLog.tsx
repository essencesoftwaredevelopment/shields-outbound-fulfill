"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Sparkles, Video } from "lucide-react";
import { apiJson } from "@/lib/api/http";
import { useConfirm } from "@/components/confirm-dialog";
import { formatDate, formatDateTime, formatMoney, fromDateTimeLocal, toDateTimeLocal } from "./format";
import {
    CALL_STATUS_LABEL,
    LOST_REASON_LABEL,
    OUTCOME_LABEL,
    type CallStatus,
    type Outcome,
    type SalesCall
} from "./types";

const PAGE_SIZE = 25;

const cellStyle = { padding: "0.45rem 0.6rem", borderTop: "1px solid var(--app-border)", whiteSpace: "nowrap" as const, verticalAlign: "top" as const };
const headStyle = { ...cellStyle, borderTop: "none", fontWeight: 600, fontSize: "0.72rem", color: "var(--app-text-faint)", textAlign: "left" as const };

type Draft = {
    company: string;
    contact_name: string;
    contact_email: string;
    booked_at: string;
    call_at: string;
    call_status: CallStatus;
    qualified: "" | "yes" | "no";
    proposal_sent_on: string;
    outcome: Outcome;
    closed_on: string;
    lost_reason: string;
    build_value: string;
    retainer_monthly: string;
    retainer_start: string;
    retainer_end: string;
    last_contact_on: string;
    next_follow_up_on: string;
    notes: string;
};

function toDraft(call: SalesCall | null): Draft {
    return {
        company: call?.company ?? "",
        contact_name: call?.contact_name ?? "",
        contact_email: call?.contact_email ?? "",
        booked_at: toDateTimeLocal(call?.booked_at ?? (call ? null : new Date().toISOString())),
        call_at: toDateTimeLocal(call?.call_at),
        call_status: call?.call_status ?? "booked",
        qualified: call?.qualified === true ? "yes" : call?.qualified === false ? "no" : "",
        proposal_sent_on: call?.proposal_sent_on ?? "",
        outcome: call?.outcome ?? "open",
        closed_on: call?.closed_on ?? "",
        lost_reason: call?.lost_reason ?? "",
        build_value: call?.build_value === null || call?.build_value === undefined ? "" : String(call.build_value),
        retainer_monthly: call?.retainer_monthly === null || call?.retainer_monthly === undefined ? "" : String(call.retainer_monthly),
        retainer_start: call?.retainer_start ?? "",
        retainer_end: call?.retainer_end ?? "",
        last_contact_on: call?.last_contact_on ?? "",
        next_follow_up_on: call?.next_follow_up_on ?? "",
        notes: call?.notes ?? ""
    };
}

function toPayload(draft: Draft) {
    const orNull = (value: string) => (value.trim() === "" ? null : value.trim());
    return {
        company: orNull(draft.company),
        contact_name: orNull(draft.contact_name),
        contact_email: orNull(draft.contact_email),
        booked_at: fromDateTimeLocal(draft.booked_at),
        call_at: fromDateTimeLocal(draft.call_at),
        call_status: draft.call_status,
        qualified: draft.qualified === "" ? null : draft.qualified === "yes",
        proposal_sent_on: orNull(draft.proposal_sent_on),
        outcome: draft.outcome,
        closed_on: orNull(draft.closed_on),
        lost_reason: draft.outcome === "lost" ? orNull(draft.lost_reason) : null,
        build_value: orNull(draft.build_value),
        retainer_monthly: orNull(draft.retainer_monthly),
        retainer_start: orNull(draft.retainer_start),
        retainer_end: orNull(draft.retainer_end),
        last_contact_on: orNull(draft.last_contact_on),
        next_follow_up_on: orNull(draft.next_follow_up_on),
        notes: orNull(draft.notes)
    };
}

function AiBadge() {
    return (
        <span
            title="Filled by AI from a call recording. Editing it makes it yours."
            style={{ display: "inline-flex", alignItems: "center", gap: "0.2rem", marginLeft: "0.35rem", fontSize: "0.68rem", fontWeight: 600, color: "var(--app-text-muted)" }}
        >
            <Sparkles size={11} /> AI
        </span>
    );
}

function Field({ label, children, wide = false, ai = false }: { label: string; children: ReactNode; wide?: boolean; ai?: boolean }) {
    return (
        <label className="label" style={{ gridColumn: wide ? "1 / -1" : undefined, fontSize: "0.8rem", gap: "0.3rem" }}>
            <span>{label}{ai && <AiBadge />}</span>
            {children}
        </label>
    );
}

const inputStyle = { padding: "0.55rem 0.75rem", fontSize: "0.88rem", borderRadius: "12px" };

function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
    return (
        <fieldset style={{ border: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <legend style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--app-text-faint)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: "0.4rem" }}>
                {title}
            </legend>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "0.6rem" }}>
                {children}
            </div>
        </fieldset>
    );
}

function SalesCallDialog({ clientId, call, onClose, onSaved }: {
    clientId: string;
    call: SalesCall | null;
    onClose: () => void;
    onSaved: () => void;
}) {
    const [draft, setDraft] = useState<Draft>(() => toDraft(call));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [confirm, confirmDialog] = useConfirm();
    const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
    const isAi = (field: string) => Boolean(call?.ai_filled_fields?.includes(field));
    const base = `/api/clients/${encodeURIComponent(clientId)}/metrics/sales-calls`;

    const save = async () => {
        setSaving(true);
        setError("");
        try {
            await apiJson(call ? `${base}/${call.id}` : base, {
                method: call ? "PATCH" : "POST",
                body: JSON.stringify(toPayload(draft))
            });
            onSaved();
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : "Failed to save.");
            setSaving(false);
        }
    };

    const remove = async () => {
        if (!call) return;
        const ok = await confirm({
            title: "Delete this call?",
            message: "It's removed from the sales log and the metrics. This can't be undone.",
            confirmLabel: "Delete call"
        });
        if (!ok) return;
        setSaving(true);
        try {
            await apiJson(`${base}/${call.id}`, { method: "DELETE" });
            onSaved();
        } catch (deleteError) {
            setError(deleteError instanceof Error ? deleteError.message : "Failed to delete.");
            setSaving(false);
        }
    };

    return (
        <div className="modal-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
            <div className="modal" role="dialog" aria-modal="true" aria-labelledby="sales-call-title" style={{ maxWidth: "760px", maxHeight: "90vh", overflowY: "auto", padding: "2rem" }}>
                <div className="modal__header">
                    <div>
                        <h2 id="sales-call-title" className="modal__title" style={{ fontSize: "1.5rem" }}>{call ? "Edit call" : "Add call"}</h2>
                        <p className="modal__description">
                            {call?.calendly_booking_id ? "Booked through Calendly. " : ""}
                            Fill in what happened; leave anything you don&apos;t know yet empty.
                        </p>
                    </div>
                </div>

                {call?.ai_summary && (
                    <div style={{ marginTop: "1rem", padding: "0.85rem 1rem", borderRadius: "14px", border: "1px solid var(--app-border-mid)", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", fontSize: "0.78rem", color: "var(--app-text-muted)" }}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", fontWeight: 600 }}><Sparkles size={13} /> From the call recording</span>
                            {call.recording_url && (
                                <a href={call.recording_url} target="_blank" rel="noreferrer" style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", color: "var(--app-text)" }}>
                                    <Video size={13} /> Open recording
                                </a>
                            )}
                        </div>
                        <p style={{ margin: 0, fontSize: "0.85rem", lineHeight: 1.45 }}>{call.ai_summary}</p>
                    </div>
                )}

                <div className="modal__body" style={{ gap: "1.25rem" }}>
                    <FieldGroup title="Who">
                        <Field label="Company"><input className="input" style={inputStyle} value={draft.company} onChange={(e) => set("company", e.target.value)} /></Field>
                        <Field label="Contact name"><input className="input" style={inputStyle} value={draft.contact_name} onChange={(e) => set("contact_name", e.target.value)} /></Field>
                        <Field label="Email"><input className="input" style={inputStyle} type="email" value={draft.contact_email} onChange={(e) => set("contact_email", e.target.value)} /></Field>
                    </FieldGroup>

                    <FieldGroup title="Call">
                        <Field label="Booked on"><input className="input" style={inputStyle} type="datetime-local" value={draft.booked_at} onChange={(e) => set("booked_at", e.target.value)} /></Field>
                        <Field label="Call time" ai={isAi("call_at")}><input className="input" style={inputStyle} type="datetime-local" value={draft.call_at} onChange={(e) => set("call_at", e.target.value)} /></Field>
                        <Field label="Status" ai={isAi("call_status")}>
                            <select className="select" style={inputStyle} value={draft.call_status} onChange={(e) => set("call_status", e.target.value as CallStatus)}>
                                {Object.entries(CALL_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                        </Field>
                        <Field label="Good fit?" ai={isAi("qualified")}>
                            <select className="select" style={inputStyle} value={draft.qualified} onChange={(e) => set("qualified", e.target.value as Draft["qualified"])}>
                                <option value="">Not decided</option>
                                <option value="yes">Yes, qualified</option>
                                <option value="no">No</option>
                            </select>
                        </Field>
                    </FieldGroup>

                    <FieldGroup title="Deal">
                        <Field label="Proposal sent on" ai={isAi("proposal_sent_on")}><input className="input" style={inputStyle} type="date" value={draft.proposal_sent_on} onChange={(e) => set("proposal_sent_on", e.target.value)} /></Field>
                        <Field label="Outcome" ai={isAi("outcome")}>
                            <select className="select" style={inputStyle} value={draft.outcome} onChange={(e) => set("outcome", e.target.value as Outcome)}>
                                {Object.entries(OUTCOME_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                        </Field>
                        {draft.outcome !== "open" && (
                            <Field label={draft.outcome === "won" ? "Signed on" : "Lost on"} ai={isAi("closed_on")}>
                                <input className="input" style={inputStyle} type="date" value={draft.closed_on} onChange={(e) => set("closed_on", e.target.value)} />
                            </Field>
                        )}
                        {draft.outcome === "lost" && (
                            <Field label="Lost reason" ai={isAi("lost_reason")}>
                                <select className="select" style={inputStyle} value={draft.lost_reason} onChange={(e) => set("lost_reason", e.target.value)}>
                                    <option value="">Pick a reason…</option>
                                    {Object.entries(LOST_REASON_LABEL).filter(([value]) => value !== "unspecified").map(([value, label]) => (
                                        <option key={value} value={value}>{label}</option>
                                    ))}
                                </select>
                            </Field>
                        )}
                        <Field label="Flow build value ($)" ai={isAi("build_value")}><input className="input" style={inputStyle} type="number" min={0} step="any" value={draft.build_value} onChange={(e) => set("build_value", e.target.value)} /></Field>
                        <Field label="Monthly retainer ($)" ai={isAi("retainer_monthly")}><input className="input" style={inputStyle} type="number" min={0} step="any" value={draft.retainer_monthly} onChange={(e) => set("retainer_monthly", e.target.value)} /></Field>
                        <Field label="Retainer started" ai={isAi("retainer_start")}><input className="input" style={inputStyle} type="date" value={draft.retainer_start} onChange={(e) => set("retainer_start", e.target.value)} /></Field>
                        <Field label="Retainer ended (churned)"><input className="input" style={inputStyle} type="date" value={draft.retainer_end} onChange={(e) => set("retainer_end", e.target.value)} /></Field>
                    </FieldGroup>

                    <FieldGroup title="Follow-up">
                        <Field label="Last contact" ai={isAi("last_contact_on")}><input className="input" style={inputStyle} type="date" value={draft.last_contact_on} onChange={(e) => set("last_contact_on", e.target.value)} /></Field>
                        <Field label="Next follow-up" ai={isAi("next_follow_up_on")}><input className="input" style={inputStyle} type="date" value={draft.next_follow_up_on} onChange={(e) => set("next_follow_up_on", e.target.value)} /></Field>
                        <Field label="Notes" wide>
                            <textarea className="input" style={{ ...inputStyle, minHeight: "70px", resize: "vertical" }} value={draft.notes} onChange={(e) => set("notes", e.target.value)} />
                        </Field>
                    </FieldGroup>

                    {error && <p className="form-error" role="alert" style={{ margin: 0 }}>{error}</p>}

                    <div className="modal__actions" style={{ justifyContent: "space-between" }}>
                        <div>
                            {call && !call.calendly_booking_id && (
                                <button type="button" className="destructive-button" onClick={() => void remove()} disabled={saving}>Delete</button>
                            )}
                        </div>
                        <div style={{ display: "flex", gap: "0.75rem" }}>
                            <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>Cancel</button>
                            <button type="button" className="primary-button" onClick={() => void save()} disabled={saving}>
                                {saving ? "Saving…" : call ? "Save" : "Add call"}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
            {confirmDialog}
        </div>
    );
}

function dealSummary(call: SalesCall) {
    const parts: string[] = [];
    if (call.build_value) parts.push(`${formatMoney(call.build_value)} build`);
    if (call.retainer_monthly) parts.push(`${formatMoney(call.retainer_monthly)}/mo`);
    return parts.join(" + ") || "—";
}

export function SalesLog({ clientId, onChanged }: { clientId: string; onChanged: () => void }) {
    const [log, setLog] = useState<{ calls: SalesCall[]; loadedAt: number } | null>(null);
    const [error, setError] = useState("");
    const [editing, setEditing] = useState<SalesCall | "new" | null>(null);
    const [shown, setShown] = useState(PAGE_SIZE);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        apiJson<{ calls: SalesCall[] }>(`/api/clients/${encodeURIComponent(clientId)}/metrics/sales-calls`)
            .then((res) => {
                if (cancelled) return;
                setLog({ calls: res.calls, loadedAt: Date.now() });
                setError("");
            })
            .catch((loadError) => {
                if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Failed to load the sales log.");
            });
        return () => {
            cancelled = true;
        };
    }, [clientId, reloadKey]);

    const calls = log?.calls ?? null;

    const onSaved = () => {
        setEditing(null);
        setReloadKey((k) => k + 1);
        onChanged();
    };

    const [open, setOpen] = useState(false);

    // Past calls nobody marked count as held in the metrics.
    const assumedHeld = (call: SalesCall) => (
        call.call_status === "booked" && call.call_at !== null && new Date(call.call_at).getTime() < (log?.loadedAt ?? 0)
    );

    return (
        <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    aria-expanded={open}
                    style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--app-text)" }}
                >
                    {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                    <span style={{ fontSize: "1.15rem", fontWeight: 650 }}>Sales log</span>
                    {calls && <span style={{ fontSize: "0.85rem", color: "var(--app-text-ghost)" }}>{calls.length} calls</span>}
                </button>
                {open && <button type="button" className="primary-button" onClick={() => setEditing("new")}>Add call</button>}
            </div>

            {error && <p className="form-error" role="alert" style={{ margin: 0 }}>{error}</p>}

            {open && (
            <>
            <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--app-text-faint)" }}>
                Calendly bookings appear here automatically. Past calls count as held unless you mark them a no-show; mark good fit,
                proposal sent and won or lost as they happen. Add existing retainer clients too, so churn and lifetime value count them.
            </p>

            {calls && calls.length === 0 && (
                <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--app-text-faint)" }}>No calls yet.</p>
            )}

            {calls && calls.length > 0 && (
                <div style={{ overflowX: "auto", border: "1px solid var(--app-border-mid)", borderRadius: "14px" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                        <thead>
                            <tr>
                                <th style={headStyle}>Call</th>
                                <th style={headStyle}>Who</th>
                                <th style={headStyle}>Status</th>
                                <th style={headStyle}>Good fit</th>
                                <th style={headStyle}>Proposal</th>
                                <th style={headStyle}>Outcome</th>
                                <th style={headStyle}>Value</th>
                                <th style={headStyle}>Next follow-up</th>
                                <th style={headStyle} />
                            </tr>
                        </thead>
                        <tbody>
                            {calls.slice(0, shown).map((call) => (
                                <tr key={call.id} style={{ opacity: call.call_status === "canceled" ? 0.55 : 1 }}>
                                    <td style={cellStyle}>{formatDateTime(call.call_at)}</td>
                                    <td style={{ ...cellStyle, whiteSpace: "normal", minWidth: "180px" }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                                            {call.company || call.contact_name || call.contact_email || "Unnamed"}
                                            {call.ai_summary && (
                                                <span title={call.ai_summary} style={{ display: "inline-flex", color: "var(--app-text-muted)" }}>
                                                    <Sparkles size={12} />
                                                </span>
                                            )}
                                            {call.recording_url && (
                                                <a href={call.recording_url} target="_blank" rel="noreferrer" aria-label="Open call recording" style={{ display: "inline-flex", color: "var(--app-text-muted)" }}>
                                                    <Video size={13} />
                                                </a>
                                            )}
                                        </div>
                                        {(call.company && (call.contact_name || call.contact_email)) && (
                                            <div style={{ fontSize: "0.75rem", color: "var(--app-text-faint)" }}>{call.contact_name || call.contact_email}</div>
                                        )}
                                    </td>
                                    <td style={cellStyle}>
                                        {assumedHeld(call)
                                            ? <span style={{ color: "var(--app-text-faint)" }}>Held (assumed)</span>
                                            : CALL_STATUS_LABEL[call.call_status]}
                                    </td>
                                    <td style={cellStyle}>{call.qualified === null ? "—" : call.qualified ? "Yes" : "No"}</td>
                                    <td style={cellStyle}>{formatDate(call.proposal_sent_on)}</td>
                                    <td style={cellStyle}>
                                        {OUTCOME_LABEL[call.outcome]}
                                        {call.outcome === "lost" && call.lost_reason && (
                                            <span style={{ color: "var(--app-text-faint)" }}> · {LOST_REASON_LABEL[call.lost_reason] ?? call.lost_reason}</span>
                                        )}
                                        {call.retainer_end && <span style={{ color: "var(--app-text-faint)" }}> · churned {formatDate(call.retainer_end)}</span>}
                                    </td>
                                    <td style={cellStyle}>{dealSummary(call)}</td>
                                    <td style={cellStyle}>{formatDate(call.next_follow_up_on)}</td>
                                    <td style={{ ...cellStyle, textAlign: "right" }}>
                                        <button type="button" className="secondary-button" style={{ padding: "0.25rem 0.7rem", fontSize: "0.78rem" }} onClick={() => setEditing(call)}>
                                            Edit
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {calls && calls.length > shown && (
                <button type="button" className="secondary-button" style={{ alignSelf: "flex-start" }} onClick={() => setShown((n) => n + PAGE_SIZE)}>
                    Show more ({calls.length - shown} left)
                </button>
            )}
            </>
            )}

            {editing && (
                <SalesCallDialog
                    clientId={clientId}
                    call={editing === "new" ? null : editing}
                    onClose={() => setEditing(null)}
                    onSaved={onSaved}
                />
            )}
        </section>
    );
}
