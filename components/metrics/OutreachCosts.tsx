"use client";

import { useCallback, useEffect, useState } from "react";
import { apiJson } from "@/lib/api/http";
import { useConfirm } from "@/components/confirm-dialog";
import { formatMoney } from "./format";
import { COST_CADENCE_LABEL, COST_CATEGORY_LABEL, type CostCadence, type OutreachCost } from "./types";

const cellStyle = { padding: "0.4rem 0.6rem", borderTop: "1px solid var(--app-border)", whiteSpace: "nowrap" as const };
const headStyle = { ...cellStyle, borderTop: "none", fontWeight: 600, fontSize: "0.72rem", color: "var(--app-text-faint)", textAlign: "left" as const };
const inputStyle = { padding: "0.4rem 0.6rem", fontSize: "0.82rem", borderRadius: "10px" };
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `month` is YYYY-MM, the value of a month input. */
type Draft = { label: string; category: string; cadence: CostCadence; amount: string; month: string };

const thisMonth = () => new Date().toISOString().slice(0, 7);
const emptyDraft = (): Draft => ({ label: "", category: "inboxes", cadence: "monthly", amount: "", month: thisMonth() });

function toDraft(cost: OutreachCost): Draft {
    return {
        label: cost.label,
        category: cost.category,
        cadence: cost.cadence,
        amount: String(cost.monthly_amount),
        month: cost.cost_month ? cost.cost_month.slice(0, 7) : thisMonth()
    };
}

function formatMonth(costMonth: string | null) {
    if (!costMonth) return "—";
    const [year, month] = costMonth.split("-");
    return `${MONTH_NAMES[Number(month) - 1] ?? month} ${year}`;
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
                <select className="select" style={inputStyle} value={draft.cadence} onChange={(e) => onChange({ ...draft, cadence: e.target.value as CostCadence })}>
                    {Object.entries(COST_CADENCE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
            </td>
            <td style={cellStyle}>
                <input className="input" style={{ ...inputStyle, width: "110px" }} type="number" min={0} step="any" placeholder="0" value={draft.amount} onChange={(e) => onChange({ ...draft, amount: e.target.value })} />
            </td>
            <td style={cellStyle}>
                {draft.cadence === "one_time" ? (
                    <input className="input" style={inputStyle} type="month" value={draft.month} onChange={(e) => onChange({ ...draft, month: e.target.value })} />
                ) : (
                    <span style={{ color: "var(--app-text-faint)" }}>Every month</span>
                )}
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
        cadence: draft.cadence,
        monthly_amount: draft.amount,
        cost_month: draft.cadence === "one_time" && draft.month ? `${draft.month}-01` : null
    });

    const draftReady = (draft: Draft) => Boolean(draft.label.trim()) && draft.amount !== "" && (draft.cadence === "monthly" || Boolean(draft.month));

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
            message: "This cost will no longer count in any period, past or future.",
            confirmLabel: "Delete cost"
        });
        if (!ok) return;
        await run(() => apiJson(`${base}/${cost.id}`, { method: "DELETE" }), () => undefined);
    };

    const monthlyTotal = (costs ?? [])
        .filter((c) => c.cadence === "monthly")
        .reduce((sum, c) => sum + c.monthly_amount, 0);

    return (
        <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div>
                <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 650 }}>Outreach costs</h3>
                <p style={{ margin: "0.15rem 0 0", fontSize: "0.82rem", color: "var(--app-text-faint)" }}>
                    Monthly costs (inboxes, domains, tools) count every month: in full for This month and Last month, and as a share for the rolling 7, 30 and 90 days.
                    One-time costs (a lead list purchase, say) count toward the month you pick.
                    Enrichment spend from pipeline jobs is added automatically, so don&apos;t enter it here.
                    {costs && costs.length > 0 && ` Monthly total: ${formatMoney(monthlyTotal)}/mo.`}
                </p>
            </div>

            {error && <p className="form-error" role="alert" style={{ margin: 0 }}>{error}</p>}

            <div style={{ overflowX: "auto", border: "1px solid var(--app-border-mid)", borderRadius: "14px" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
                    <thead>
                        <tr>
                            <th style={headStyle}>Cost</th>
                            <th style={headStyle}>Category</th>
                            <th style={headStyle}>Type</th>
                            <th style={headStyle}>Amount ($)</th>
                            <th style={headStyle}>Month</th>
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
                                            <button type="button" className="primary-button" style={{ padding: "0.25rem 0.7rem", fontSize: "0.78rem" }} onClick={() => void saveEdit(cost.id)} disabled={saving || !draftReady(editDraft)}>Save</button>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                <tr key={cost.id}>
                                    <td style={cellStyle}>{cost.label}</td>
                                    <td style={cellStyle}>{COST_CATEGORY_LABEL[cost.category] ?? cost.category}</td>
                                    <td style={cellStyle}>{COST_CADENCE_LABEL[cost.cadence] ?? cost.cadence}</td>
                                    <td style={cellStyle}>{formatMoney(cost.monthly_amount)}{cost.cadence === "monthly" ? "/mo" : ""}</td>
                                    <td style={cellStyle}>{cost.cadence === "one_time" ? formatMonth(cost.cost_month) : "Every month"}</td>
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
                                    disabled={saving || !draftReady(newDraft)}
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
