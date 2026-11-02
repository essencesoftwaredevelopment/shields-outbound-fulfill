"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
    BadgeCheck,
    Banknote,
    CalendarCheck,
    FileText,
    Gem,
    MessageCircleCheck,
    RefreshCw,
    Scale,
    SendHorizontal,
    Target,
    Trophy,
    UserCheck,
    UserMinus,
    UserPlus,
    Wallet
} from "lucide-react";
import { apiJson } from "@/lib/api/http";
import { SalesLog } from "./SalesLog";
import { OutreachCosts } from "./OutreachCosts";
import { formatMoney, formatNumber, formatPercent } from "./format";
import type { MetricsPayload } from "./types";

type Status = "good" | "warn" | "bad" | null;

const STATUS_COLOR: Record<Exclude<Status, null>, string> = {
    good: "var(--app-success-solid)",
    warn: "var(--app-warning-heading)",
    bad: "var(--app-danger-solid)"
};

/** Higher is better: good at or above `good`, warn at or above `warn`. */
function atLeast(value: number | null | undefined, good: number, warn: number): Status {
    if (value === null || value === undefined) return null;
    return value >= good ? "good" : value >= warn ? "warn" : "bad";
}

const ICON_PROPS = { width: 18, height: 18, strokeWidth: 1.8 };

/**
 * Same layout as the Analytics tab stat cards: big number, optional secondary
 * value + label, then icon + label. `hint` (formula, target) shows on hover.
 */
function MetricCard({ label, value, secondary, icon, status, hint }: {
    label: string;
    value: string;
    secondary?: { value: string; label: string };
    icon: ReactNode;
    status?: Status;
    hint?: string;
}) {
    return (
        <div
            title={hint}
            style={{
                padding: "1.35rem 1.2rem",
                borderRadius: "16px",
                border: "1px solid var(--app-border-mid)",
                display: "flex",
                flexDirection: "column",
                minWidth: 0
            }}
        >
            <p style={{ margin: 0, fontSize: "3rem", lineHeight: 1, fontWeight: 700 }}>{value}</p>
            <div style={{ margin: "0.45rem 0 0", minHeight: "1.32rem", lineHeight: 1.1 }}>
                {secondary && (
                    <p style={{ margin: 0, fontSize: "1.2rem", fontWeight: 300, color: "var(--app-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                        {secondary.value}
                        <span style={{ marginLeft: "0.3rem", fontSize: "0.78rem", fontWeight: 500, color: "var(--app-text-ghost)" }}>
                            {secondary.label}
                        </span>
                    </p>
                )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", marginTop: "0.55rem" }}>
                <span style={{ display: "inline-flex", color: "var(--app-text)", flexShrink: 0 }}>{icon}</span>
                <p style={{ margin: 0, fontSize: "0.86rem", color: "var(--app-text-muted)" }}>{label}</p>
                {status && (
                    <span
                        role="img"
                        aria-label={status === "good" ? "On target" : status === "warn" ? "Below target" : "Off target"}
                        style={{ marginLeft: "auto", width: "8px", height: "8px", borderRadius: "999px", background: STATUS_COLOR[status], flexShrink: 0 }}
                    />
                )}
            </div>
        </div>
    );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <h3 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 650 }}>{title}</h3>
            {children}
        </section>
    );
}

function Grid({ children }: { children: ReactNode }) {
    return (
        <div style={{
            display: "grid",
            // Up to 5 per row (fewer when narrow); the row's max width keeps cards at ≤350px.
            gridTemplateColumns: "repeat(auto-fill, minmax(max(180px, calc((100% - 4rem) / 5)), 1fr))",
            maxWidth: "calc(5 * 350px + 4rem)",
            gap: "1rem"
        }}>
            {children}
        </div>
    );
}

/** "4 Oct – 2 Nov 2026" (inclusive, UTC days as the server computes them). */
function formatRange(start: string, end: string) {
    const toDate = (iso: string) => new Date(`${iso}T12:00:00Z`);
    const from = toDate(start);
    const to = toDate(end);
    const dayMonth = { day: "numeric", month: "short", timeZone: "UTC" } as const;
    const withYear = { ...dayMonth, year: "numeric" } as const;
    const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
    return `${from.toLocaleDateString("en-GB", sameYear ? dayMonth : withYear)} – ${to.toLocaleDateString("en-GB", withYear)}`;
}

function minutesAgo(iso: string) {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    return minutes < 1 ? "just now" : `${minutes} min ago`;
}

export function MetricsTab({ clientId }: { clientId: string }) {
    const [period, setPeriod] = useState("30d");
    const [data, setData] = useState<MetricsPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [inputsVersion, setInputsVersion] = useState(0);

    const load = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            setData(await apiJson<MetricsPayload>(`/api/clients/${encodeURIComponent(clientId)}/metrics?period=${encodeURIComponent(period)}`));
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Failed to load metrics.");
        } finally {
            setLoading(false);
        }
    }, [clientId, period]);

    useEffect(() => {
        void load();
    }, [load, inputsVersion]);

    const onInputsChanged = useCallback(() => setInputsVersion((v) => v + 1), []);

    const sending = data?.sending;
    const replies = data?.replies;
    const sales = data?.sales;
    const money = data?.money;
    const newContactTarget = sending?.plannedNewContactsPerDay ?? 3000;

    return (
        <div style={{ marginTop: "2rem", display: "flex", flexDirection: "column", gap: "2rem" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                    <h2 style={{ margin: 0, fontSize: "1.75rem", fontWeight: 700 }}>Metrics</h2>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                        <select
                            className="instantly-refill__select"
                            value={period}
                            onChange={(e) => setPeriod(e.target.value)}
                            aria-label="Period"
                        >
                            {(data?.periods ?? [{ key: "30d", label: "Last 30 days" }]).map((p) => (
                                <option key={p.key} value={p.key}>{p.label}</option>
                            ))}
                        </select>
                        {data && data.period.key === period && (
                            <span style={{ fontSize: "0.85rem", color: "var(--app-text-muted)" }}>
                                {formatRange(data.period.start, data.period.end)}
                            </span>
                        )}
                    </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                    {data && !loading && <span style={{ fontSize: "0.75rem", color: "var(--app-text-ghost)" }}>Updated {minutesAgo(data.computedAt)}</span>}
                    <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void load()}
                        disabled={loading}
                        aria-label="Refresh metrics"
                        style={{ padding: "0.3rem 0.5rem", display: "inline-flex", alignItems: "center" }}
                    >
                        <RefreshCw size={14} />
                    </button>
                </div>
            </div>

            {error && <p className="form-error" role="alert" style={{ margin: 0 }}>{error}</p>}
            {data?.warnings.map((warning) => (
                <p key={warning} style={{ margin: 0, fontSize: "0.8rem", color: "var(--app-warning-text)" }}>{warning}</p>
            ))}

            {loading && !data && (
                <Grid>
                    {Array.from({ length: 3 }, (_, i) => (
                        <div key={i} className="analytics-skeleton" style={{ height: "150px", borderRadius: "16px" }} />
                    ))}
                </Grid>
            )}

            {data && (
                <div style={{ display: "flex", flexDirection: "column", gap: "2rem", opacity: loading ? 0.6 : 1, transition: "opacity 150ms" }}>
                    <Section title="1. Cold Email">
                        <Grid>
                            <MetricCard
                                label="Emails sent"
                                value={formatNumber(sending?.emailsSent)}
                                secondary={{ value: formatPercent(sending?.capacityUsed, 0), label: `Capacity used (${formatNumber(sending?.maxPossibleSends)})` }}
                                icon={<SendHorizontal {...ICON_PROPS} />}
                                status={atLeast(sending?.capacityUsed, 0.9, 0.7)}
                                hint={sending ? `${formatNumber(sending.emailsSent)} sent of ${formatNumber(sending.maxPossibleSends)} possible: today's ${formatNumber(sending.capacityPerDay)} sends/day × ${sending.workingDays} working days. Target: 90%+.` : undefined}
                            />
                            <MetricCard
                                label="New contacts / working day"
                                value={formatNumber(sending?.newContactsPerWorkingDay)}
                                secondary={{ value: formatPercent(sending?.capacityUsed, 0), label: "Capacity used" }}
                                icon={<UserPlus {...ICON_PROPS} />}
                                status={atLeast(sending?.capacityUsed, 0.9, 0.7)}
                                hint={sending ? `${formatNumber(sending.newContacts)} new contacts over ${sending.workingDays} working days. ${formatNumber(sending.emailsSent)} of ${formatNumber(sending.maxPossibleSends)} possible sends at today's ${formatNumber(sending.capacityPerDay)}/day. Target: ${formatNumber(newContactTarget)}+ a day, 90%+ capacity.` : undefined}
                            />
                            <MetricCard
                                label="Positive replies"
                                value={formatNumber(replies?.positives)}
                                secondary={{ value: formatPercent(replies?.positiveRate, 2), label: "PRR" }}
                                icon={<MessageCircleCheck {...ICON_PROPS} />}
                                status={atLeast(replies?.positiveRate, 0.0025, 0.002)}
                                hint={`Positives ÷ ${formatNumber(replies?.newContacts)} contacts emailed. Target: 0.25%+; swap the script below 0.2%.`}
                            />
                        </Grid>
                    </Section>

                    <Section title="2. Sales">
                        <Grid>
                            <MetricCard
                                label="Calls booked"
                                value={formatNumber(sales?.callsBooked)}
                                secondary={{ value: formatPercent(sales?.bookingRate, 0), label: "Booking rate" }}
                                icon={<CalendarCheck {...ICON_PROPS} />}
                                status={atLeast(sales?.bookingRate, 0.2, 0.12)}
                                hint={`Unique people who booked a call (Calendly or Instantly "meeting booked"), including cancellations. Booking rate = calls booked ÷ positive replies. Target: 20–25%.${sales?.callsCanceled ? ` ${sales.callsCanceled} canceled without rebooking.` : ""}`}
                            />
                            <MetricCard
                                label="Show rate"
                                value={formatPercent(sales?.showRate, 0)}
                                secondary={{ value: formatNumber(sales?.callsHeld), label: "Calls held" }}
                                icon={<UserCheck {...ICON_PROPS} />}
                                status={atLeast(sales?.showRate, 0.7, 0.5)}
                                hint={`Calls held ÷ (held + no-shows + people who canceled). Past Calendly calls count as held unless marked a no-show in Calendly. Target: 70%+.`}
                            />
                            <MetricCard
                                label="Qualified rate"
                                value={formatPercent(sales?.qualifiedRate, 0)}
                                secondary={{ value: formatNumber(sales?.qualified), label: "Good fit" }}
                                icon={<BadgeCheck {...ICON_PROPS} />}
                                hint="Good-fit calls ÷ calls held. Shows lead quality."
                            />
                            <MetricCard
                                label="Proposal rate"
                                value={formatPercent(sales?.proposalRate, 0)}
                                secondary={{ value: formatNumber(sales?.proposalsSent), label: "Proposals" }}
                                icon={<FileText {...ICON_PROPS} />}
                                status={atLeast(sales?.proposalRate, 0.5, 0.3)}
                                hint="Proposals sent ÷ calls held. Target: 50%+."
                            />
                            <MetricCard
                                label="Close rate"
                                value={formatPercent(sales?.closeRate, 0)}
                                secondary={{ value: formatPercent(sales?.overallCloseRate, 0), label: "Of calls held" }}
                                icon={<Trophy {...ICON_PROPS} />}
                                status={atLeast(sales?.closeRate, 0.3, 0.15)}
                                hint={`Deals won (${formatNumber(sales?.dealsWon)}) ÷ proposals sent. Target: 30%+. Of calls held target: 15–25%.`}
                            />
                        </Grid>
                    </Section>

                    <Section title="3. Money">
                        <Grid>
                            <MetricCard
                                label="New revenue"
                                value={formatMoney(money?.newRevenue)}
                                secondary={{ value: `${formatMoney(money?.retainerRevenue)}/mo`, label: "Retainers" }}
                                icon={<Banknote {...ICON_PROPS} />}
                                hint={money ? `${formatMoney(money.buildRevenue)} flow builds + ${formatMoney(money.retainerRevenue)}/mo new retainers.` : undefined}
                            />
                            <MetricCard
                                label="Average deal value"
                                value={formatMoney(money?.avgDealValue)}
                                secondary={{ value: formatNumber(sales?.dealsWon), label: "Deals won" }}
                                icon={<Scale {...ICON_PROPS} />}
                                hint="New revenue ÷ deals won (build + first month of retainer)."
                            />
                            <MetricCard
                                label="Outreach cost"
                                value={formatMoney(money?.outreachCost)}
                                secondary={{ value: formatMoney(money?.costPerBookedCall), label: "Per booked call" }}
                                icon={<Wallet {...ICON_PROPS} />}
                                hint={money?.costBreakdown.map((line) => `${line.label} ${formatMoney(line.amount)}`).join(" · ")}
                            />
                            <MetricCard
                                label="Cost to win a client"
                                value={formatMoney(money?.costPerClient)}
                                secondary={{ value: money?.paybackMonths === null || money?.paybackMonths === undefined ? "—" : `${formatNumber(money.paybackMonths, 1)} mo`, label: "Payback" }}
                                icon={<Target {...ICON_PROPS} />}
                                hint="Outreach cost ÷ deals won. Payback = cost to win a client ÷ monthly retainer."
                            />
                            <MetricCard
                                label="Monthly churn"
                                value={formatPercent(money?.monthlyChurn, 1)}
                                secondary={{ value: formatNumber(money?.activeRetainers), label: "Active clients" }}
                                icon={<UserMinus {...ICON_PROPS} />}
                                hint={money ? `${money.churnedInPeriod} ended of ${money.activeAtPeriodStart} active at the start of the period. MRR ${formatMoney(money.mrr)}/mo.` : undefined}
                            />
                            <MetricCard
                                label="Lifetime value"
                                value={formatMoney(money?.lifetimeValue)}
                                secondary={{ value: formatNumber(money?.avgTenureMonths, 1), label: "Avg months" }}
                                icon={<Gem {...ICON_PROPS} />}
                                hint="Average months a client stays × average retainer. Active clients count their time so far."
                            />
                        </Grid>
                    </Section>
                </div>
            )}

            <SalesLog clientId={clientId} onChanged={onInputsChanged} />
            <OutreachCosts clientId={clientId} onChanged={onInputsChanged} />
        </div>
    );
}
