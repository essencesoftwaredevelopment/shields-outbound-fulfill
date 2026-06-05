"use client";

type ChartRow = {
    bucket: string;
    label: string;
    count: number;
};

type InstantlyEventAnalyticsChartProps = {
    rows: ChartRow[];
    bucketUnit: "hour" | "day";
    windowLabel: string;
    eventTypeLabel: string;
    loading?: boolean;
};

export default function InstantlyEventAnalyticsChart({
    rows,
    bucketUnit,
    windowLabel,
    eventTypeLabel,
    loading = false
}: InstantlyEventAnalyticsChartProps) {
    const safeRows = rows.length > 0 ? rows : [];
    const maxCount = Math.max(1, ...safeRows.map((row) => row.count));
    const totalCount = safeRows.reduce((sum, row) => sum + row.count, 0);
    const showEveryNthLabel = safeRows.length > 18 ? Math.ceil(safeRows.length / 12) : safeRows.length > 10 ? 2 : 1;

    return (
        <div style={{
            padding: "1.25rem",
            borderRadius: "16px",
            background: "var(--app-surface-3)",
            border: "1px solid var(--app-border)",
            opacity: loading ? 0.65 : 1,
            transition: "opacity 0.2s ease"
        }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", marginBottom: "1rem" }}>
                <div>
                    <p className="eyebrow eyebrow--muted" style={{ margin: 0 }}>Events over time</p>
                    <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", color: "var(--app-text-muted)" }}>
                        {windowLabel} · {eventTypeLabel}
                    </p>
                </div>
                <div style={{ textAlign: "right" }}>
                    <p style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700, lineHeight: 1 }}>
                        {totalCount.toLocaleString()}
                    </p>
                    <p style={{ margin: "0.2rem 0 0", fontSize: "0.75rem", color: "var(--app-text-ghost)" }}>
                        total events
                    </p>
                </div>
            </div>

            {safeRows.length === 0 ? (
                <div className="pipeline-panel__empty" style={{ minHeight: "180px" }}>
                    <p>No events in this period for the selected filters.</p>
                </div>
            ) : (
                <div>
                    <div
                        role="img"
                        aria-label={`Bar chart of ${totalCount} events across ${safeRows.length} ${bucketUnit === "hour" ? "hours" : "days"}`}
                        style={{
                            display: "flex",
                            alignItems: "flex-end",
                            gap: safeRows.length > 40 ? "2px" : safeRows.length > 20 ? "3px" : "6px",
                            height: "180px",
                            padding: "0.25rem 0 0"
                        }}
                    >
                        {safeRows.map((row) => {
                            const heightPct = Math.max((row.count / maxCount) * 100, row.count > 0 ? 4 : 0);
                            return (
                                <div
                                    key={row.bucket}
                                    title={`${row.label}: ${row.count.toLocaleString()} event${row.count === 1 ? "" : "s"}`}
                                    style={{
                                        flex: "1 1 0",
                                        minWidth: 0,
                                        display: "flex",
                                        flexDirection: "column",
                                        justifyContent: "flex-end",
                                        alignItems: "stretch",
                                        height: "100%"
                                    }}
                                >
                                    <div
                                        style={{
                                            height: `${heightPct}%`,
                                            minHeight: row.count > 0 ? "4px" : 0,
                                            borderRadius: "4px 4px 2px 2px",
                                            background: row.count > 0
                                                ? "linear-gradient(180deg, #60a5fa 0%, #3b82f6 100%)"
                                                : "rgba(148, 163, 184, 0.12)",
                                            boxShadow: row.count > 0 ? "0 0 0 1px rgba(59, 130, 246, 0.18)" : "none",
                                            transition: "height 0.25s ease"
                                        }}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    <div style={{
                        display: "flex",
                        gap: safeRows.length > 40 ? "2px" : safeRows.length > 20 ? "3px" : "6px",
                        marginTop: "0.55rem"
                    }}>
                        {safeRows.map((row, index) => (
                            <div
                                key={`${row.bucket}-label`}
                                style={{
                                    flex: "1 1 0",
                                    minWidth: 0,
                                    fontSize: "0.62rem",
                                    color: "var(--app-text-ghost)",
                                    textAlign: "center",
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    visibility: index % showEveryNthLabel === 0 || index === safeRows.length - 1 ? "visible" : "hidden"
                                }}
                            >
                                {row.label}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
