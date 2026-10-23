"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { apiJson } from "@/lib/api/http";

type RunwayCampaign = {
    id: string;
    name: string;
    status: string;
    active: boolean;
    inboxes: number;
    sharedInboxes: number;
    sendsPerDay: number;
    dailyLimit: number | null;
    dailyMaxLeads: number | null;
    steps: number;
    newLeadsPerDay: number;
    limitedBy: "daily_max_leads" | "campaign_daily_limit" | "inboxes" | null;
    backlog: number;
    inSequence: number;
    runwayDays: number | null;
    runsDryOn: string | null;
};

type RunwayPayload = {
    totals: {
        activeCampaigns: number;
        inboxes: number;
        sendsPerDay: number;
        newLeadsPerDay: number;
        backlog: number;
        inSequence: number;
        pausedBacklog: number;
        backlogRunwayDays: number | null;
        backlogRunsDryOn: string | null;
        reserve: { verified: number; withFirstLine: number; extraDays: number | null };
        totalRunwayDays: number | null;
        totalRunsDryOn: string | null;
    };
    campaigns: RunwayCampaign[];
    warnings: string[];
    computedAt: string;
    leadsSyncedAt: string | null;
};

const LIMITED_BY_LABEL: Record<string, string> = {
    daily_max_leads: "campaign new-lead cap",
    campaign_daily_limit: "campaign daily limit",
    inboxes: "inbox limits"
};

function formatDay(isoDate: string | null) {
    if (!isoDate) return "—";
    return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function formatDays(days: number | null) {
    if (days === null) return "—";
    return `${days.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${days === 1 ? "day" : "days"}`;
}

function minutesAgo(iso: string) {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return minutes < 1 ? "just now" : `${minutes} min ago`;
}

const cellStyle = { padding: "0.5rem 0.6rem", borderTop: "1px solid var(--app-border)", whiteSpace: "nowrap" as const };
const headStyle = { ...cellStyle, borderTop: "none", fontWeight: 600, fontSize: "0.75rem", color: "var(--app-text-faint)", textAlign: "left" as const };

export function SendingRunwayCard({ clientId }: { clientId: string }) {
    const [data, setData] = useState<RunwayPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [showCampaigns, setShowCampaigns] = useState(false);

    const load = useCallback(async (refresh = false) => {
        setLoading(true);
        setError("");
        try {
            const params = refresh ? "?refresh=1" : "";
            setData(await apiJson<RunwayPayload>(`/api/clients/${encodeURIComponent(clientId)}/analytics/runway${params}`));
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Failed to load sending runway.");
        } finally {
            setLoading(false);
        }
    }, [clientId]);

    useEffect(() => {
        void load();
    }, [load]);

    const totals = data?.totals;
    const shown = data?.campaigns.filter((row) => row.active || row.backlog > 0) || [];

    return (
        <div style={{ padding: "1.35rem 1.2rem", borderRadius: "16px", border: "1px solid var(--app-border-mid)", display: "flex", flexDirection: "column", gap: "0.9rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem" }}>
                <p style={{ margin: 0, fontSize: "0.86rem", color: "var(--app-text-muted)" }}>Sending runway</p>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", fontSize: "0.75rem", color: "var(--app-text-ghost)" }}>
                    {data && !loading && <span>Updated {minutesAgo(data.computedAt)}</span>}
                    <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void load(true)}
                        disabled={loading}
                        aria-label="Refresh sending runway"
                        style={{ padding: "0.3rem 0.5rem", display: "inline-flex", alignItems: "center" }}
                    >
                        <RefreshCw size={14} />
                    </button>
                </div>
            </div>

            {error && <p className="form-error" role="alert" style={{ margin: 0 }}>{error}</p>}

            {loading && !data && (
                <>
                    <div className="analytics-skeleton" style={{ width: "180px", height: "48px" }} />
                    <div className="analytics-skeleton" style={{ width: "320px", height: "18px" }} />
                </>
            )}

            {totals && (
                <>
                    <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", flexWrap: "wrap" }}>
                        <p style={{ margin: 0, fontSize: "3rem", lineHeight: 1, fontWeight: 700 }}>
                            {totals.totalRunwayDays === null ? "—" : totals.totalRunwayDays.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                        </p>
                        <p style={{ margin: 0, fontSize: "1.2rem", fontWeight: 300, color: "var(--app-text-muted)" }}>
                            sending days
                            {totals.totalRunsDryOn && (
                                <span style={{ marginLeft: "0.4rem", fontSize: "0.9rem", color: "var(--app-text-ghost)" }}>
                                    · new prospects run out {formatDay(totals.totalRunsDryOn)}
                                </span>
                            )}
                        </p>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "0.75rem", fontSize: "0.86rem", color: "var(--app-text-muted)" }}>
                        <div>
                            <strong style={{ color: "var(--app-text)" }}>{formatDays(totals.backlogRunwayDays)}</strong> in campaigns
                            <div style={{ fontSize: "0.78rem", color: "var(--app-text-ghost)" }}>
                                {totals.backlog.toLocaleString()} leads not yet contacted · until {formatDay(totals.backlogRunsDryOn)}
                            </div>
                        </div>
                        <div>
                            <strong style={{ color: "var(--app-text)" }}>+{formatDays(totals.reserve.extraDays)}</strong> in the lead bank
                            <div style={{ fontSize: "0.78rem", color: "var(--app-text-ghost)" }}>
                                {totals.reserve.verified.toLocaleString()} verified, never in a campaign ({totals.reserve.withFirstLine.toLocaleString()} with first lines)
                            </div>
                        </div>
                        <div>
                            <strong style={{ color: "var(--app-text)" }}>{totals.newLeadsPerDay.toLocaleString()}</strong> new prospects / day
                            <div style={{ fontSize: "0.78rem", color: "var(--app-text-ghost)" }}>
                                {totals.sendsPerDay.toLocaleString()} emails/day · {totals.inboxes.toLocaleString()} inboxes · {totals.activeCampaigns} active campaign{totals.activeCampaigns === 1 ? "" : "s"}
                            </div>
                        </div>
                        <div>
                            <strong style={{ color: "var(--app-text)" }}>{totals.inSequence.toLocaleString()}</strong> mid-sequence
                            <div style={{ fontSize: "0.78rem", color: "var(--app-text-ghost)" }}>
                                still getting follow-ups{totals.pausedBacklog ? ` · ${totals.pausedBacklog.toLocaleString()} uncontacted in paused campaigns` : ""}
                            </div>
                        </div>
                    </div>

                    {data.warnings.length > 0 && (
                        <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.8rem", color: "var(--app-warn-text)" }}>
                            {data.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                        </ul>
                    )}

                    {shown.length > 0 && (
                        <div>
                            <button
                                type="button"
                                className="secondary-button"
                                onClick={() => setShowCampaigns((prev) => !prev)}
                                style={{ fontSize: "0.8rem" }}
                            >
                                {showCampaigns ? "Hide campaigns" : `By campaign (${shown.length})`}
                            </button>
                            {showCampaigns && (
                                <div style={{ overflowX: "auto", marginTop: "0.6rem" }}>
                                    <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.82rem" }}>
                                        <thead>
                                            <tr>
                                                <th style={headStyle}>Campaign</th>
                                                <th style={headStyle}>Inboxes</th>
                                                <th style={headStyle}>Emails / day</th>
                                                <th style={headStyle}>New / day</th>
                                                <th style={headStyle}>Not contacted</th>
                                                <th style={headStyle}>Mid-sequence</th>
                                                <th style={headStyle}>Runs out</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {shown.map((row) => (
                                                <tr key={row.id} style={{ color: row.active ? "var(--app-text)" : "var(--app-text-ghost)" }}>
                                                    <td style={{ ...cellStyle, whiteSpace: "normal", minWidth: "200px" }}>
                                                        {row.name}
                                                        {!row.active && <span style={{ marginLeft: "0.4rem", fontSize: "0.72rem" }}>({row.status})</span>}
                                                    </td>
                                                    <td style={cellStyle}>
                                                        {row.inboxes.toLocaleString()}
                                                        {row.sharedInboxes > 0 && (
                                                            <span title="Inboxes shared with other active campaigns; their daily limit is split." style={{ marginLeft: "0.3rem", fontSize: "0.72rem", color: "var(--app-text-ghost)" }}>
                                                                ({row.sharedInboxes} shared)
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td style={cellStyle}>{row.active ? row.sendsPerDay.toLocaleString() : "—"}</td>
                                                    <td style={cellStyle} title={row.limitedBy ? `Limited by ${LIMITED_BY_LABEL[row.limitedBy]} · ${row.steps}-step sequence` : undefined}>
                                                        {row.active ? row.newLeadsPerDay.toLocaleString() : "—"}
                                                    </td>
                                                    <td style={cellStyle}>{row.backlog.toLocaleString()}</td>
                                                    <td style={cellStyle}>{row.inSequence.toLocaleString()}</td>
                                                    <td style={cellStyle}>
                                                        {row.runwayDays === null ? "—" : `${formatDays(row.runwayDays)} · ${formatDay(row.runsDryOn)}`}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    )}

                    <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--app-text-ghost)" }}>
                        From live Instantly settings: each campaign&apos;s tagged inboxes and daily limits, divided by its sequence length and capped by its new-lead limit. Lead counts as of the last Instantly sync{data.leadsSyncedAt ? ` (${minutesAgo(data.leadsSyncedAt)})` : ""}.
                    </p>
                </>
            )}
        </div>
    );
}
