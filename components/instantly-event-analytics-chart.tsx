"use client";

import { useId, useMemo } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    type ChartConfig,
} from "@/components/ui/chart";

type ChartRow = {
    bucket: string;
    label: string;
    count: number;
    emails_sent?: number;
    positive_replies?: number;
    meetings_booked?: number;
};

type InstantlyEventAnalyticsChartProps = {
    rows: ChartRow[];
    bucketUnit: "hour" | "day";
    windowLabel: string;
    eventTypeLabel: string;
    loading?: boolean;
    showPositiveReplies?: boolean;
    showMeetingsBooked?: boolean;
};

type ChartDataPoint = {
    bucket: string;
    label: string;
    count: number;
    emails_sent: number;
    positive_replies: number;
    meetings_booked: number;
};

const outreachChartConfig = {
    emails_sent: {
        label: "Emails sent",
        color: "#3b82f6",
    },
    positive_replies: {
        label: "Positive replies",
        color: "#22c55e",
    },
    meetings_booked: {
        label: "Meetings booked",
        color: "#a855f7",
    },
} satisfies ChartConfig;

const filteredChartConfig = {
    count: {
        label: "Events",
        color: "#3b82f6",
    },
} satisfies ChartConfig;

function formatAxisTick(value: number) {
    if (value >= 1000) {
        return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, "")}k`;
    }
    return value.toLocaleString();
}

function buildChartData(rows: ChartRow[]): ChartDataPoint[] {
    return rows.map((row) => ({
        bucket: row.bucket,
        label: row.label,
        count: row.count,
        emails_sent: row.emails_sent ?? 0,
        positive_replies: row.positive_replies ?? 0,
        meetings_booked: row.meetings_booked ?? 0,
    }));
}

export default function InstantlyEventAnalyticsChart({
    rows,
    bucketUnit,
    windowLabel,
    eventTypeLabel,
    loading = false,
    showPositiveReplies = false,
    showMeetingsBooked = false,
}: InstantlyEventAnalyticsChartProps) {
    const chartId = useId().replace(/:/g, "");
    const useOutreachView = showPositiveReplies || showMeetingsBooked;
    const primaryDataKey = useOutreachView ? "emails_sent" : "count";
    const chartConfig = useOutreachView ? outreachChartConfig : filteredChartConfig;
    const chartData = useMemo(() => buildChartData(rows), [rows]);

    const totalPrimaryCount = useMemo(
        () => chartData.reduce((sum, row) => sum + (useOutreachView ? row.emails_sent : row.count), 0),
        [chartData, useOutreachView]
    );
    const totalPositiveCount = useMemo(
        () => rows.reduce((sum, row) => sum + (row.positive_replies ?? 0), 0),
        [rows]
    );
    const totalMeetingsBookedCount = useMemo(
        () => rows.reduce((sum, row) => sum + (row.meetings_booked ?? 0), 0),
        [rows]
    );

    const lifecycleAxisMax = useMemo(() => Math.max(
        1,
        ...chartData.map((point) => point.positive_replies),
        ...chartData.map((point) => point.meetings_booked)
    ), [chartData]);

    const chartMargin = {
        top: 8,
        right: useOutreachView ? 8 : 12,
        left: 4,
        bottom: 0,
    };

    const primaryTotalLabel = useOutreachView ? "total emails" : "total events";
    const xAxisInterval = bucketUnit === "hour" && chartData.length > 12 ? "preserveStartEnd" : 0;

    return (
        <div style={{
            padding: "1.25rem",
            borderRadius: "16px",
            background: "var(--app-surface-3)",
            border: "1px solid var(--app-border)",
        }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", marginBottom: "1rem" }}>
                <div>
                    <p className="eyebrow eyebrow--muted" style={{ margin: 0 }}>
                        {useOutreachView ? "Outreach over time" : "Events over time"}
                    </p>
                    <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", color: "var(--app-text-muted)" }}>
                        {windowLabel} · {eventTypeLabel}
                    </p>
                    {useOutreachView && !loading && rows.length > 0 && (
                        <div style={{ display: "flex", gap: "1rem", marginTop: "0.65rem", flexWrap: "wrap" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.72rem", color: "var(--app-text-muted)" }}>
                                <span style={{ width: "14px", height: "3px", borderRadius: "999px", background: "linear-gradient(90deg, #93c5fd, #3b82f6)" }} />
                                Emails sent
                            </div>
                            {showPositiveReplies && (
                                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.72rem", color: "var(--app-text-muted)" }}>
                                    <span style={{ width: "14px", height: "3px", borderRadius: "999px", background: "linear-gradient(90deg, #86efac, #22c55e)" }} />
                                    Positive replies
                                </div>
                            )}
                            {showMeetingsBooked && (
                                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.72rem", color: "var(--app-text-muted)" }}>
                                    <span style={{ width: "14px", height: "3px", borderRadius: "999px", background: "linear-gradient(90deg, #c4b5fd, #a855f7)" }} />
                                    Meetings booked
                                </div>
                            )}
                        </div>
                    )}
                </div>
                <div style={{ textAlign: "right", minWidth: "88px" }}>
                    {loading ? (
                        <>
                            <div className="analytics-skeleton" style={{ width: "72px", height: "28px", marginLeft: "auto" }} />
                            <div className="analytics-skeleton" style={{ width: "64px", height: "10px", marginTop: "0.45rem", marginLeft: "auto" }} />
                        </>
                    ) : (
                        <>
                            <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, lineHeight: 1 }}>
                                {totalPrimaryCount.toLocaleString()}
                            </p>
                            <p style={{ margin: "0.2rem 0 0", fontSize: "0.75rem", color: "var(--app-text-ghost)" }}>
                                {primaryTotalLabel}
                            </p>
                            {showPositiveReplies && (
                                <p style={{ margin: "0.55rem 0 0", fontSize: "0.95rem", fontWeight: 600, lineHeight: 1, color: "#22c55e" }}>
                                    {totalPositiveCount.toLocaleString()}
                                    <span style={{ marginLeft: "0.25rem", fontSize: "0.72rem", fontWeight: 500, color: "var(--app-text-ghost)" }}>
                                        positive
                                    </span>
                                </p>
                            )}
                            {showMeetingsBooked && (
                                <p style={{ margin: "0.55rem 0 0", fontSize: "0.95rem", fontWeight: 600, lineHeight: 1, color: "#a855f7" }}>
                                    {totalMeetingsBookedCount.toLocaleString()}
                                    <span style={{ marginLeft: "0.25rem", fontSize: "0.72rem", fontWeight: 500, color: "var(--app-text-ghost)" }}>
                                        meetings
                                    </span>
                                </p>
                            )}
                        </>
                    )}
                </div>
            </div>

            {loading ? (
                <div style={{ position: "relative", minHeight: "220px" }}>
                    <div className="analytics-skeleton" style={{ position: "absolute", inset: "0 0 28px 0", borderRadius: "12px" }} />
                    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, display: "flex", gap: "0.75rem" }}>
                        {Array.from({ length: 6 }).map((_, index) => (
                            <div key={index} className="analytics-skeleton" style={{ flex: 1, height: "10px" }} />
                        ))}
                    </div>
                </div>
            ) : rows.length === 0 ? (
                <div className="pipeline-panel__empty" style={{ minHeight: "220px" }}>
                    <p>No events in this period for the selected filters.</p>
                </div>
            ) : (
                <div className="analytics-chart-enter">
                    <ChartContainer
                        config={chartConfig}
                        className="aspect-auto h-[220px] w-full"
                        initialDimension={{ width: 800, height: 220 }}
                    >
                        <AreaChart data={chartData} margin={chartMargin}>
                            <defs>
                                <linearGradient id={`${chartId}-fill-primary`} x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor={`var(--color-${primaryDataKey})`} stopOpacity={0.42} />
                                    <stop offset="95%" stopColor={`var(--color-${primaryDataKey})`} stopOpacity={0.02} />
                                </linearGradient>
                            </defs>

                            <CartesianGrid vertical={false} stroke="rgba(148, 163, 184, 0.1)" />

                            <XAxis
                                dataKey="label"
                                type="category"
                                tickLine={false}
                                axisLine={false}
                                tickMargin={8}
                                interval={xAxisInterval}
                                minTickGap={24}
                                padding={{ left: 0, right: 0 }}
                            />

                            <YAxis
                                yAxisId="events"
                                tickLine={false}
                                axisLine={false}
                                tickMargin={8}
                                width={44}
                                tickFormatter={formatAxisTick}
                            />

                            {useOutreachView && (
                                <YAxis
                                    yAxisId="lifecycle"
                                    orientation="right"
                                    domain={[0, lifecycleAxisMax]}
                                    allowDecimals={lifecycleAxisMax > 5}
                                    tickLine={false}
                                    axisLine={false}
                                    tickMargin={8}
                                    width={44}
                                    tickFormatter={(value) => (
                                        lifecycleAxisMax <= 5
                                            ? String(Math.round(value))
                                            : formatAxisTick(value)
                                    )}
                                />
                            )}

                            <ChartTooltip
                                cursor={{ stroke: "rgba(148, 163, 184, 0.35)", strokeWidth: 1 }}
                                content={
                                    <ChartTooltipContent
                                        indicator="dot"
                                        labelKey="label"
                                    />
                                }
                            />

                            <Area
                                yAxisId="events"
                                dataKey={primaryDataKey}
                                name={primaryDataKey}
                                type="monotone"
                                fill={`url(#${chartId}-fill-primary)`}
                                stroke={`var(--color-${primaryDataKey})`}
                                strokeWidth={2}
                                dot={false}
                                activeDot={{ r: 4, strokeWidth: 2 }}
                            />

                            {showPositiveReplies && (
                                <Area
                                    yAxisId="lifecycle"
                                    dataKey="positive_replies"
                                    name="positive_replies"
                                    type="monotone"
                                    fill="none"
                                    stroke="var(--color-positive_replies)"
                                    strokeWidth={2}
                                    dot={false}
                                    activeDot={{ r: 4, strokeWidth: 2 }}
                                />
                            )}

                            {showMeetingsBooked && (
                                <Area
                                    yAxisId="lifecycle"
                                    dataKey="meetings_booked"
                                    name="meetings_booked"
                                    type="monotone"
                                    fill="none"
                                    stroke="var(--color-meetings_booked)"
                                    strokeWidth={2}
                                    dot={false}
                                    activeDot={{ r: 4, strokeWidth: 2 }}
                                />
                            )}
                        </AreaChart>
                    </ChartContainer>
                </div>
            )}
        </div>
    );
}
