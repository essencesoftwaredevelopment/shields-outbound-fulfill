"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/api/http";
import { useConfirm } from "@/components/confirm-dialog";
import { formatDate, formatMoney } from "./format";
import { COST_CATEGORY_LABEL, type OutreachCost } from "./types";

const cellStyle = { padding: "0.4rem 0.6rem", borderTop: "1px solid var(--app-border)", whiteSpace: "nowrap" as const };
const headStyle = { ...cellStyle, borderTop: "none", fontWeight: 600, fontSize: "0.72rem", color: "var(--app-text-faint)", textAlign: "left" as const };
const inputStyle = { padding: "0.4rem 0.6rem", fontSize: "0.82rem", borderRadius: "10px" };

type Draft = { label: string; category: string; monthly_amount: string; starts_on: string; ends_on: string };

const today = () => new Date().toISOString().slice(0, 10);
const emptyDraft = (): Draft => ({ label: "", category: "inboxes", monthly_amount: "", starts_on: today(), ends_on: "" });

function toDraft(cost: OutreachCost): Draft {
    return {
        label: cost.label,
        category: cost.category,
        monthly_amount: String(cost.monthly_amount),
        starts_on: cost.starts_on,
        ends_on: cost.ends_on ?? ""
    };
}

function DraftCells({ draft, onChange }: { draft: Draft; onChange: (draft: Draft) => void }) {
    return (
        <>
            <td style={cellStyle}>
                <input className="input" style={{ ...inputStyle, minWidth: "180px" }} placeholder="e.g. 405 inboxes" value={draft.label} onChange={(e) => onChange({ ...draft, label: e.target.value })} />
            </td>
            <td style={cellStyle}>
                <select className="select" style={inputStyle} value={draft.category} onChange={(e) => onChange({ ...draft, category: e.target.value })}>
                    {Object.entries(COST_CATEGORY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
            </td>
            <td style={cellStyle}>
                <input className="input" style={{ ...inputStyle, width: "110px" }} type="number" min={0} step="any" placeholder="0" value={draft.monthly_amount} onChange={(e) => onChange({ ...draft, monthly_amount: e.target.value })} />
            </td>
            <td style={cellStyle}>
                <input className="input" style={inputStyle} type="date" value={draft.starts_on} onChange={(e) => onChange({ ...draft, starts_on: e.target.value })} />
            </td>
            <td style={cellStyle}>
                <input className="input" style={inputStyle} type="date" value={draft.ends_on} onChange={(e) => onChange({ ...draft, ends_on: e.target.value })} />
            </td>
        </>
    );
}

export function OutreachCosts({ clientId, onChanged }: { clientId: string; onChanged: () => void }) {
    const [costs, setCosts] = useState<OutreachCost[] | null>(null);
    const [error, setError] = useState("");
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);
    const [newDraft, setNewDraft] = useState<Draft>(emptyDraft);
    const [saving, setSaving] = useState(false);
    const [confirm, confirmDialog] = useConfirm();
    const base = `/api/clients/${encodeURIComponent(clientId)}/metrics/costs`;

    const load = useCallback(async () => {
        try {
            const res = await apiJson<{ costs: OutreachCost[] }>(base);
            setCosts(res.costs);
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Failed to load outreach costs.");
        }
    }, [base]);

    useEffect(() => {
        void load();
    }, [load]);

    const payload = (draft: Draft) => ({
        label: draft.label,
        category: draft.category,
        monthly_amount: draft.monthly_amount,
        starts_on: draft.starts_on || null,
        ends_on: draft.ends_on || null
    });

    const run = async (action: () => Promise<unknown>, after: () => void) => {
        setSaving(true);
        setError("");
        try {
            await action();
            after();
            await load();
            onChanged();
        } catch (actionError) {
            setError(actionError instanceof Error ? actionError.message : "Failed to save.");
        } finally {
            setSaving(false);
        }
    };

    const add = () => run(
        () => apiJson(base, { method: "POST", body: JSON.stringify(payload(newDraft)) }),
        () => setNewDraft(emptyDraft())
    );

    const saveEdit = (id: number) => run(
        () => apiJson(`${base}/${id}`, { method: "PATCH", body: JSON.stringify(payload(editDraft)) }),
        () => setEditingId(null)
    );

    const remove = async (cost: OutreachCost) => {
        const ok = await confirm({
            title: `Delete "${cost.label}"?`,
            message: "Past periods will no longer include this cost. To stop a cost from today on, set an end date instead.",
            confirmLabel: "Delete cost"
        });
        if (!ok) return;
        await run(() => apiJson(`${base}/${cost.id}`, { method: "DELETE" }), () => undefined);
    };

    const monthlyTotal = (costs ?? [])
        .filter((c) => !c.ends_on || c.ends_on >= today())
        .reduce((sum, c) => sum + c.monthly_amount, 0);

    return (
        <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div>
                <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 650 }}>Outreach costs</h3>
                <p style={{ margin: "0.15rem 0 0", fontSize: "0.82rem", color: "var(--app-text-faint)" }}>
                    Recurring monthly costs (inboxes, domains, tools, lead data). Each period is charged for the days it overlaps.
                    Enrichment spend from pipeline jobs is added automatically, so don&apos;t enter it here.
                    {costs && costs.length > 0 && ` Current total: ${formatMoney(monthlyTotal)}/mo.`}
                </p>
            </div>

            {error && <p className="form-error" role="alert" style={{ margin: 0 }}>{error}</p>}

            <div style={{ overflowX: "auto", border: "1px solid var(--app-border-mid)", borderRadius: "14px" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                    <thead>
                        <tr>
                            <th style={headStyle}>Cost</th>
                            <th style={headStyle}>Category</th>
                            <th style={headStyle}>Per month ($)</th>
                            <th style={headStyle}>From</th>
                            <th style={headStyle}>Until</th>
                            <th style={headStyle} />
                        </tr>
                    </thead>
                    <tbody>
                        {(costs ?? []).map((cost) => (
                            editingId === cost.id ? (
                                <tr key={cost.id}>
                                    <DraftCells draft={editDraft} onChange={setEditDraft} />
                                    <td style={{ ...cellStyle, textAlign: "right" }}>
                                        <div style={{ display: "inline-flex", gap: "0.4rem" }}>
                                            <button type="button" className="secondary-button" style={{ padding: "0.25rem 0.7rem", fontSize: "0.78rem" }} onClick={() => setEditingId(null)} disabled={saving}>Cancel</button>
                                            <button type="button" className="primary-button" style={{ padding: "0.25rem 0.7rem", fontSize: "0.78rem" }} onClick={() => void saveEdit(cost.id)} disabled={saving}>Save</button>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                <tr key={cost.id} style={{ opacity: cost.ends_on && cost.ends_on < today() ? 0.55 : 1 }}>
                                    <td style={cellStyle}>{cost.label}</td>
                                    <td style={cellStyle}>{COST_CATEGORY_LABEL[cost.category] ?? cost.category}</td>
                                    <td style={cellStyle}>{formatMoney(cost.monthly_amount)}</td>
                                    <td style={cellStyle}>{formatDate(cost.starts_on)}</td>
                                    <td style={cellStyle}>{cost.ends_on ? formatDate(cost.ends_on) : "Ongoing"}</td>
                                    <td style={{ ...cellStyle, textAlign: "right" }}>
                                        <div style={{ display: "inline-flex", gap: "0.4rem" }}>
                                            <button
                                                type="button"
                                                className="secondary-button"
                                                style={{ padding: "0.25rem 0.7rem", fontSize: "0.78rem" }}
                                                onClick={() => { setEditingId(cost.id); setEditDraft(toDraft(cost)); }}
                                                disabled={saving}
                                            >
                                                Edit
                                            </button>
                                            <button
                                                type="button"
                                                className="destructive-button destructive-button--compact"
                                                onClick={() => void remove(cost)}
                                                disabled={saving}
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            )
                        ))}
                        <tr>
                            <DraftCells draft={newDraft} onChange={setNewDraft} />
                            <td style={{ ...cellStyle, textAlign: "right" }}>
                                <button
                                    type="button"
                                    className="primary-button"
                                    style={{ padding: "0.25rem 0.8rem", fontSize: "0.78rem" }}
                                    onClick={() => void add()}
                                    disabled={saving || !newDraft.label.trim() || newDraft.monthly_amount === ""}
                                >
                                    Add
                                </button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            {confirmDialog}
        </section>
    );
}
