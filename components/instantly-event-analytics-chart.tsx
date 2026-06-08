"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";

type ChartRow = {
    bucket: string;
    label: string;
    count: number;
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

type ChartPoint = {
    x: number;
    y: number;
    row: ChartRow;
    index: number;
};

type SeriesPathParts = {
    solid: string;
    dotted: string;
    solidPoints: ChartPoint[];
    nowPoint: ChartPoint | null;
};

const CHART_WIDTH = 1000;
const CHART_HEIGHT = 220;
const PADDING = { top: 16, right: 40, bottom: 30, left: 40 };

function isAtFloor(point: ChartPoint, floorY: number | null) {
    return floorY !== null && Math.abs(point.y - floorY) < 0.5;
}

function clampControlY(
    controlY: number,
    currentY: number,
    nextY: number,
    floorY: number | null
) {
    if (floorY === null) return controlY;

    const segmentHighY = Math.min(currentY, nextY);
    const segmentLowY = Math.max(currentY, nextY);
    return Math.max(segmentHighY, Math.min(segmentLowY, controlY));
}

function buildSmoothPath(points: ChartPoint[], floorY: number | null = null) {
    if (points.length === 0) return "";
    if (points.length === 1) {
        return `M ${points[0].x} ${points[0].y}`;
    }

    let path = `M ${points[0].x} ${points[0].y}`;
    for (let index = 0; index < points.length - 1; index += 1) {
        const previous = points[index - 1] || points[index];
        const current = points[index];
        const next = points[index + 1];
        const afterNext = points[index + 2] || next;

        if (floorY !== null && (isAtFloor(current, floorY) || isAtFloor(next, floorY))) {
            path += ` L ${next.x} ${next.y}`;
            continue;
        }

        const control1X = current.x + (next.x - previous.x) / 6;
        const control1Y = clampControlY(
            current.y + (next.y - previous.y) / 6,
            current.y,
            next.y,
            floorY
        );
        const control2X = next.x - (afterNext.x - current.x) / 6;
        const control2Y = clampControlY(
            next.y - (afterNext.y - current.y) / 6,
            current.y,
            next.y,
            floorY
        );

        path += ` C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${next.x} ${next.y}`;
    }

    return path;
}

function buildDottedPath(from: ChartPoint, to: ChartPoint) {
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

function buildSeriesPaths(
    points: ChartPoint[],
    nowPoint: ChartPoint | null,
    floorY: number | null
): SeriesPathParts {
    if (points.length === 0) {
        return { solid: "", dotted: "", solidPoints: [], nowPoint: null };
    }

    const solid = buildSmoothPath(points, floorY);
    const dottedAnchor = points[points.length - 1];
    const dotted = nowPoint && dottedAnchor.x < nowPoint.x - 0.5
        ? buildDottedPath(dottedAnchor, nowPoint)
        : "";

    return { solid, dotted, solidPoints: points, nowPoint };
}

function buildAreaPath(solidPath: string, solidPoints: ChartPoint[], baselineY: number) {
    if (!solidPath || solidPoints.length === 0) return "";
    const first = solidPoints[0];
    const last = solidPoints[solidPoints.length - 1];
    return `${solidPath} L ${last.x} ${baselineY} L ${first.x} ${baselineY} Z`;
}

function valueToY(value: number, maxValue: number, plotHeight: number, baselineY: number) {
    return baselineY - (value / maxValue) * plotHeight;
}

function buildChartPoints({
    rows,
    nowX,
    plotWidth,
    plotHeight,
    baselineY,
    maxValue,
    getValue
}: {
    rows: ChartRow[];
    nowX: number;
    plotWidth: number;
    plotHeight: number;
    baselineY: number;
    maxValue: number;
    getValue: (row: ChartRow) => number;
}): { points: ChartPoint[]; nowPoint: ChartPoint | null } {
    if (rows.length === 0) {
        return { points: [], nowPoint: null };
    }

    const bucketCount = rows.length;
    const completeRows = bucketCount >= 2 ? rows.slice(0, -1) : rows;
    const partialRow = rows[bucketCount - 1];
    const slotCount = Math.max(1, bucketCount - 1);
    const stepX = plotWidth / slotCount;
    const xForIndex = (index: number) => PADDING.left + stepX * index;

    const points = completeRows.map((row, index) => {
        const value = getValue(row);
        return {
            x: xForIndex(index),
            y: valueToY(value, maxValue, plotHeight, baselineY),
            row,
            index
        };
    });

    const nowPoint = bucketCount >= 2
        ? {
            x: nowX,
            y: valueToY(getValue(partialRow), maxValue, plotHeight, baselineY),
            row: partialRow,
            index: bucketCount - 1
        }
        : null;

    return { points, nowPoint };
}

function formatAxisTick(value: number) {
    if (value >= 1000) {
        return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, "")}k`;
    }
    return value.toLocaleString();
}

export default function InstantlyEventAnalyticsChart({
    rows,
    bucketUnit,
    windowLabel,
    eventTypeLabel,
    loading = false,
    showPositiveReplies = false,
    showMeetingsBooked = false
}: InstantlyEventAnalyticsChartProps) {
    const chartId = useId().replace(/:/g, "");
    const containerRef = useRef<HTMLDivElement>(null);
    const [hoverState, setHoverState] = useState<{ mouseX: number; activeIndex: number } | null>(null);

    const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right;
    const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;
    const baselineY = PADDING.top + plotHeight;

    const maxEventCount = useMemo(
        () => Math.max(1, ...rows.map((row) => row.count)),
        [rows]
    );
    const maxPositiveCount = useMemo(
        () => Math.max(1, ...rows.map((row) => row.positive_replies ?? 0)),
        [rows]
    );
    const maxMeetingsBookedCount = useMemo(
        () => Math.max(1, ...rows.map((row) => row.meetings_booked ?? 0)),
        [rows]
    );

    const nowX = PADDING.left + plotWidth;
    const eventsFloorY = rows.some((row) => row.count < 0) ? null : baselineY;
    const positiveFloorY = rows.some((row) => (row.positive_replies ?? 0) < 0) ? null : baselineY;
    const meetingsFloorY = rows.some((row) => (row.meetings_booked ?? 0) < 0) ? null : baselineY;

    const eventSeries = useMemo(
        () => buildChartPoints({
            rows,
            nowX,
            plotWidth,
            plotHeight,
            baselineY,
            maxValue: maxEventCount,
            getValue: (row) => row.count
        }),
        [baselineY, maxEventCount, nowX, plotHeight, plotWidth, rows]
    );

    const positiveSeries = useMemo(
        () => (showPositiveReplies
            ? buildChartPoints({
                rows,
                nowX,
                plotWidth,
                plotHeight,
                baselineY,
                maxValue: maxPositiveCount,
                getValue: (row) => row.positive_replies ?? 0
            })
            : { points: [], nowPoint: null }),
        [baselineY, maxPositiveCount, nowX, plotHeight, plotWidth, rows, showPositiveReplies]
    );

    const meetingsSeries = useMemo(
        () => (showMeetingsBooked
            ? buildChartPoints({
                rows,
                nowX,
                plotWidth,
                plotHeight,
                baselineY,
                maxValue: maxMeetingsBookedCount,
                getValue: (row) => row.meetings_booked ?? 0
            })
            : { points: [], nowPoint: null }),
        [baselineY, maxMeetingsBookedCount, nowX, plotHeight, plotWidth, rows, showMeetingsBooked]
    );

    const points = eventSeries.points;
    const positivePoints = positiveSeries.points;
    const meetingsBookedPoints = meetingsSeries.points;
    const nowPoint = eventSeries.nowPoint;

    const eventPaths = useMemo(
        () => buildSeriesPaths(points, nowPoint, eventsFloorY),
        [eventsFloorY, nowPoint, points]
    );
    const positivePaths = useMemo(
        () => buildSeriesPaths(positivePoints, positiveSeries.nowPoint, positiveFloorY),
        [positiveFloorY, positivePoints, positiveSeries.nowPoint]
    );
    const meetingsPaths = useMemo(
        () => buildSeriesPaths(meetingsBookedPoints, meetingsSeries.nowPoint, meetingsFloorY),
        [meetingsBookedPoints, meetingsFloorY, meetingsSeries.nowPoint]
    );

    const linePath = eventPaths.solid;
    const lineDottedPath = eventPaths.dotted;
    const positiveLinePath = positivePaths.solid;
    const positiveDottedPath = positivePaths.dotted;
    const meetingsBookedLinePath = meetingsPaths.solid;
    const meetingsDottedPath = meetingsPaths.dotted;
    const areaPath = useMemo(
        () => buildAreaPath(linePath, eventPaths.solidPoints, baselineY),
        [baselineY, eventPaths.solidPoints, linePath]
    );
    const totalCount = useMemo(() => rows.reduce((sum, row) => sum + row.count, 0), [rows]);
    const totalPositiveCount = useMemo(
        () => rows.reduce((sum, row) => sum + (row.positive_replies ?? 0), 0),
        [rows]
    );
    const totalMeetingsBookedCount = useMemo(
        () => rows.reduce((sum, row) => sum + (row.meetings_booked ?? 0), 0),
        [rows]
    );
    const labelCount = points.length + (nowPoint ? 1 : 0);
    const showEveryNthLabel = labelCount > 18 ? Math.ceil(labelCount / 12) : labelCount > 10 ? 2 : 1;
    const axisTicks = [0, 0.5, 1];

    const handlePointerMove = useCallback((clientX: number) => {
        const container = containerRef.current;
        if (!container || points.length === 0) return;

        const rect = container.getBoundingClientRect();
        const relativeX = ((clientX - rect.left) / rect.width) * CHART_WIDTH;
        const clampedX = Math.max(PADDING.left, Math.min(nowX, relativeX));

        const hoverCandidates = nowPoint ? [...points, nowPoint] : points;
        let nearestIndex = 0;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const point of hoverCandidates) {
            const distance = Math.abs(point.x - clampedX);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestIndex = point.index;
            }
        }

        setHoverState({ mouseX: clampedX, activeIndex: nearestIndex });
    }, [nowPoint, nowX, points]);

    const clearHover = useCallback(() => {
        setHoverState(null);
    }, []);

    const activePoint = hoverState
        ? (hoverState.activeIndex === nowPoint?.index ? nowPoint : points[hoverState.activeIndex])
        : null;
    const activePositivePoint = hoverState && showPositiveReplies
        ? (hoverState.activeIndex === positiveSeries.nowPoint?.index
            ? positiveSeries.nowPoint
            : positivePoints[hoverState.activeIndex])
        : null;
    const activeMeetingsBookedPoint = hoverState && showMeetingsBooked
        ? (hoverState.activeIndex === meetingsSeries.nowPoint?.index
            ? meetingsSeries.nowPoint
            : meetingsBookedPoints[hoverState.activeIndex])
        : null;
    const crosshairLeftPct = hoverState ? (hoverState.mouseX / CHART_WIDTH) * 100 : 0;
    const activePointLeftPct = activePoint ? (activePoint.x / CHART_WIDTH) * 100 : 0;
    const activePositivePointLeftPct = activePositivePoint ? (activePositivePoint.x / CHART_WIDTH) * 100 : 0;
    const activeMeetingsBookedPointLeftPct = activeMeetingsBookedPoint ? (activeMeetingsBookedPoint.x / CHART_WIDTH) * 100 : 0;
    const activePointTopPct = activePoint ? (activePoint.y / CHART_HEIGHT) * 100 : 0;
    const activePositivePointTopPct = activePositivePoint ? (activePositivePoint.y / CHART_HEIGHT) * 100 : 0;
    const activeMeetingsBookedPointTopPct = activeMeetingsBookedPoint ? (activeMeetingsBookedPoint.y / CHART_HEIGHT) * 100 : 0;
    const chartSeriesKey = rows.map((row) => `${row.bucket}:${row.count}:${row.positive_replies ?? 0}:${row.meetings_booked ?? 0}`).join("|");

    return (
        <div style={{
            padding: "1.25rem",
            borderRadius: "16px",
            background: "var(--app-surface-3)",
            border: "1px solid var(--app-border)"
        }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", flexWrap: "wrap", marginBottom: "1rem" }}>
                <div>
                    <p className="eyebrow eyebrow--muted" style={{ margin: 0 }}>Events over time</p>
                    <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", color: "var(--app-text-muted)" }}>
                        {windowLabel} · {eventTypeLabel}
                    </p>
                    {(showPositiveReplies || showMeetingsBooked) && !loading && rows.length > 0 && (
                        <div style={{ display: "flex", gap: "1rem", marginTop: "0.65rem", flexWrap: "wrap" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.72rem", color: "var(--app-text-muted)" }}>
                                <span style={{ width: "14px", height: "3px", borderRadius: "999px", background: "linear-gradient(90deg, #93c5fd, #3b82f6)" }} />
                                Events
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
                                {totalCount.toLocaleString()}
                            </p>
                            <p style={{ margin: "0.2rem 0 0", fontSize: "0.75rem", color: "var(--app-text-ghost)" }}>
                                total events
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
                <div key={chartSeriesKey} className="analytics-chart-enter">
                    <div
                        ref={containerRef}
                        style={{ position: "relative", touchAction: "none", height: "220px" }}
                        onMouseMove={(event) => handlePointerMove(event.clientX)}
                        onMouseLeave={clearHover}
                        onTouchStart={(event) => {
                            if (event.touches[0]) handlePointerMove(event.touches[0].clientX);
                        }}
                        onTouchMove={(event) => {
                            if (event.touches[0]) handlePointerMove(event.touches[0].clientX);
                        }}
                        onTouchEnd={clearHover}
                    >
                    <svg
                        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                        preserveAspectRatio="xMidYMid meet"
                        role="img"
                        aria-label={`Line chart of ${totalCount} events${showPositiveReplies ? `, ${totalPositiveCount} positive replies` : ""}${showMeetingsBooked ? `, and ${totalMeetingsBookedCount} meetings booked` : ""} across ${rows.length} ${bucketUnit === "hour" ? "hours" : "days"}`}
                        style={{ display: "block", width: "100%", height: "100%", overflow: "visible" }}
                    >
                        <defs>
                            <linearGradient id={`${chartId}-area`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.42" />
                                <stop offset="55%" stopColor="#3b82f6" stopOpacity="0.16" />
                                <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
                            </linearGradient>
                            <linearGradient id={`${chartId}-line`} x1="0" y1="0" x2="1" y2="0">
                                <stop offset="0%" stopColor="#93c5fd" />
                                <stop offset="100%" stopColor="#3b82f6" />
                            </linearGradient>
                            <linearGradient id={`${chartId}-positive-line`} x1="0" y1="0" x2="1" y2="0">
                                <stop offset="0%" stopColor="#86efac" />
                                <stop offset="100%" stopColor="#22c55e" />
                            </linearGradient>
                            <linearGradient id={`${chartId}-meetings-line`} x1="0" y1="0" x2="1" y2="0">
                                <stop offset="0%" stopColor="#c4b5fd" />
                                <stop offset="100%" stopColor="#a855f7" />
                            </linearGradient>
                            <clipPath id={`${chartId}-plot`}>
                                <rect x={PADDING.left} y={PADDING.top} width={plotWidth} height={plotHeight} />
                            </clipPath>
                        </defs>

                        {Array.from({ length: 4 }).map((_, index) => {
                            const y = PADDING.top + (plotHeight / 3) * index;
                            return (
                                <line
                                    key={index}
                                    x1={PADDING.left}
                                    x2={CHART_WIDTH - PADDING.right}
                                    y1={y}
                                    y2={y}
                                    stroke="rgba(148, 163, 184, 0.1)"
                                    strokeWidth="1"
                                    vectorEffect="non-scaling-stroke"
                                />
                            );
                        })}

                        {axisTicks.map((tick) => {
                            const y = PADDING.top + plotHeight - tick * plotHeight;
                            const eventValue = Math.round(maxEventCount * tick);
                            const positiveValue = Math.round(maxPositiveCount * tick);
                            return (
                                <g key={`axis-${tick}`}>
                                    <text
                                        x={PADDING.left - 8}
                                        y={y + 4}
                                        textAnchor="end"
                                        fill="rgba(148, 163, 184, 0.72)"
                                        fontSize="11"
                                        style={{ fontVariantNumeric: "tabular-nums" }}
                                    >
                                        {formatAxisTick(eventValue)}
                                    </text>
                                    {showPositiveReplies && maxPositiveCount > 1 && (
                                        <text
                                            x={CHART_WIDTH - PADDING.right + 8}
                                            y={y + 4}
                                            textAnchor="start"
                                            fill="rgba(34, 197, 94, 0.82)"
                                            fontSize="11"
                                            style={{ fontVariantNumeric: "tabular-nums" }}
                                        >
                                            {formatAxisTick(positiveValue)}
                                        </text>
                                    )}
                                </g>
                            );
                        })}

                        <g clipPath={`url(#${chartId}-plot)`}>
                        {areaPath && (
                            <path
                                d={areaPath}
                                fill={`url(#${chartId}-area)`}
                                className="analytics-chart-area"
                            />
                        )}

                        {linePath && (
                            <path
                                d={linePath}
                                fill="none"
                                stroke={`url(#${chartId}-line)`}
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                pathLength={1}
                                className="analytics-chart-line"
                                vectorEffect="non-scaling-stroke"
                            />
                        )}

                        {lineDottedPath && (
                            <path
                                d={lineDottedPath}
                                fill="none"
                                stroke="#3b82f6"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="analytics-chart-line--projected"
                                vectorEffect="non-scaling-stroke"
                            />
                        )}

                        {positiveLinePath && (
                            <path
                                d={positiveLinePath}
                                fill="none"
                                stroke={`url(#${chartId}-positive-line)`}
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                pathLength={1}
                                className="analytics-chart-line analytics-chart-line--secondary"
                                vectorEffect="non-scaling-stroke"
                            />
                        )}

                        {positiveDottedPath && (
                            <path
                                d={positiveDottedPath}
                                fill="none"
                                stroke="#22c55e"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="analytics-chart-line--projected analytics-chart-line--projected-secondary"
                                vectorEffect="non-scaling-stroke"
                            />
                        )}

                        {meetingsBookedLinePath && (
                            <path
                                d={meetingsBookedLinePath}
                                fill="none"
                                stroke={`url(#${chartId}-meetings-line)`}
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                pathLength={1}
                                className="analytics-chart-line analytics-chart-line--tertiary"
                                vectorEffect="non-scaling-stroke"
                            />
                        )}

                        {meetingsDottedPath && (
                            <path
                                d={meetingsDottedPath}
                                fill="none"
                                stroke="#a855f7"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="analytics-chart-line--projected analytics-chart-line--projected-tertiary"
                                vectorEffect="non-scaling-stroke"
                            />
                        )}
                        </g>

                    </svg>

                    {hoverState && (
                        <div
                            aria-hidden
                            style={{
                                position: "absolute",
                                top: `${(PADDING.top / CHART_HEIGHT) * 100}%`,
                                bottom: `${((CHART_HEIGHT - baselineY) / CHART_HEIGHT) * 100}%`,
                                left: `${crosshairLeftPct}%`,
                                width: "1px",
                                transform: "translateX(-0.5px)",
                                background: "repeating-linear-gradient(to bottom, rgba(148, 163, 184, 0.55) 0 4px, transparent 4px 8px)",
                                pointerEvents: "none",
                                zIndex: 1
                            }}
                        />
                    )}

                    {hoverState && activePoint && nowPoint && hoverState.activeIndex === nowPoint.index && (
                        <>
                            <div
                                aria-hidden
                                style={{
                                    position: "absolute",
                                    top: `${activePointTopPct}%`,
                                    left: `${(nowPoint.x / CHART_WIDTH) * 100}%`,
                                    width: "20px",
                                    height: "20px",
                                    transform: "translate(-50%, -50%)",
                                    borderRadius: "999px",
                                    background: "rgba(59, 130, 246, 0.18)",
                                    pointerEvents: "none",
                                    zIndex: 2
                                }}
                            />
                            <div
                                aria-hidden
                                style={{
                                    position: "absolute",
                                    top: `${activePointTopPct}%`,
                                    left: `${(nowPoint.x / CHART_WIDTH) * 100}%`,
                                    width: "10px",
                                    height: "10px",
                                    transform: "translate(-50%, -50%)",
                                    borderRadius: "999px",
                                    background: "#3b82f6",
                                    border: "2px solid rgba(255, 255, 255, 0.9)",
                                    boxShadow: "0 0 0 1px rgba(59, 130, 246, 0.35)",
                                    pointerEvents: "none",
                                    zIndex: 3
                                }}
                            />
                        </>
                    )}

                    {hoverState && activePoint && hoverState.activeIndex !== nowPoint?.index && (
                        <>
                            <div
                                aria-hidden
                                style={{
                                    position: "absolute",
                                    top: `${activePointTopPct}%`,
                                    left: `${activePointLeftPct}%`,
                                    width: "20px",
                                    height: "20px",
                                    transform: "translate(-50%, -50%)",
                                    borderRadius: "999px",
                                    background: "rgba(59, 130, 246, 0.18)",
                                    pointerEvents: "none",
                                    zIndex: 2
                                }}
                            />
                            <div
                                aria-hidden
                                style={{
                                    position: "absolute",
                                    top: `${activePointTopPct}%`,
                                    left: `${activePointLeftPct}%`,
                                    width: "10px",
                                    height: "10px",
                                    transform: "translate(-50%, -50%)",
                                    borderRadius: "999px",
                                    background: "#3b82f6",
                                    border: "2px solid rgba(255, 255, 255, 0.9)",
                                    boxShadow: "0 0 0 1px rgba(59, 130, 246, 0.35)",
                                    pointerEvents: "none",
                                    zIndex: 3
                                }}
                            />
                        </>
                    )}

                    {hoverState && activePositivePoint && (
                        <>
                            <div
                                aria-hidden
                                style={{
                                    position: "absolute",
                                    top: `${activePositivePointTopPct}%`,
                                    left: `${activePositivePointLeftPct}%`,
                                    width: "20px",
                                    height: "20px",
                                    transform: "translate(-50%, -50%)",
                                    borderRadius: "999px",
                                    background: "rgba(34, 197, 94, 0.16)",
                                    pointerEvents: "none",
                                    zIndex: 2
                                }}
                            />
                            <div
                                aria-hidden
                                style={{
                                    position: "absolute",
                                    top: `${activePositivePointTopPct}%`,
                                    left: `${activePositivePointLeftPct}%`,
                                    width: "10px",
                                    height: "10px",
                                    transform: "translate(-50%, -50%)",
                                    borderRadius: "999px",
                                    background: "#22c55e",
                                    border: "2px solid rgba(255, 255, 255, 0.9)",
                                    boxShadow: "0 0 0 1px rgba(34, 197, 94, 0.35)",
                                    pointerEvents: "none",
                                    zIndex: 3
                                }}
                            />
                        </>
                    )}

                    {hoverState && activeMeetingsBookedPoint && (
                        <>
                            <div
                                aria-hidden
                                style={{
                                    position: "absolute",
                                    top: `${activeMeetingsBookedPointTopPct}%`,
                                    left: `${activeMeetingsBookedPointLeftPct}%`,
                                    width: "20px",
                                    height: "20px",
                                    transform: "translate(-50%, -50%)",
                                    borderRadius: "999px",
                                    background: "rgba(168, 85, 247, 0.16)",
                                    pointerEvents: "none",
                                    zIndex: 2
                                }}
                            />
                            <div
                                aria-hidden
                                style={{
                                    position: "absolute",
                                    top: `${activeMeetingsBookedPointTopPct}%`,
                                    left: `${activeMeetingsBookedPointLeftPct}%`,
                                    width: "10px",
                                    height: "10px",
                                    transform: "translate(-50%, -50%)",
                                    borderRadius: "999px",
                                    background: "#a855f7",
                                    border: "2px solid rgba(255, 255, 255, 0.9)",
                                    boxShadow: "0 0 0 1px rgba(168, 85, 247, 0.35)",
                                    pointerEvents: "none",
                                    zIndex: 3
                                }}
                            />
                        </>
                    )}

                    {hoverState && activePoint && (
                        <div
                            style={{
                                position: "absolute",
                                top: "8px",
                                left: `${crosshairLeftPct}%`,
                                transform: crosshairLeftPct > 72 ? "translateX(-100%)" : crosshairLeftPct < 28 ? "translateX(0)" : "translateX(-50%)",
                                pointerEvents: "none",
                                padding: "0.45rem 0.65rem",
                                borderRadius: "10px",
                                background: "rgba(15, 23, 42, 0.92)",
                                border: "1px solid rgba(148, 163, 184, 0.22)",
                                boxShadow: "0 8px 24px rgba(0, 0, 0, 0.28)",
                                zIndex: 4,
                                minWidth: "92px"
                            }}
                        >
                            <p style={{ margin: 0, fontSize: "0.68rem", color: "var(--app-text-ghost)", whiteSpace: "nowrap" }}>
                                {hoverState.activeIndex === nowPoint?.index ? "Now" : activePoint.row.label}
                            </p>
                            <p style={{ margin: "0.15rem 0 0", fontSize: "0.92rem", fontWeight: 700, color: "#f8fafc", lineHeight: 1.2 }}>
                                {activePoint.row.count.toLocaleString()}
                                <span style={{ marginLeft: "0.25rem", fontSize: "0.72rem", fontWeight: 500, color: "var(--app-text-muted)" }}>
                                    event{activePoint.row.count === 1 ? "" : "s"}
                                </span>
                            </p>
                            {showPositiveReplies && (
                                <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", fontWeight: 600, color: "#86efac", lineHeight: 1.2 }}>
                                    {(activePoint.row.positive_replies ?? 0).toLocaleString()}
                                    <span style={{ marginLeft: "0.25rem", fontSize: "0.68rem", fontWeight: 500, color: "rgba(134, 239, 172, 0.72)" }}>
                                        positive
                                    </span>
                                </p>
                            )}
                            {showMeetingsBooked && (
                                <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", fontWeight: 600, color: "#c4b5fd", lineHeight: 1.2 }}>
                                    {(activePoint.row.meetings_booked ?? 0).toLocaleString()}
                                    <span style={{ marginLeft: "0.25rem", fontSize: "0.68rem", fontWeight: 500, color: "rgba(196, 181, 253, 0.72)" }}>
                                        meetings
                                    </span>
                                </p>
                            )}
                        </div>
                    )}
                    </div>

                    <div style={{
                        position: "relative",
                        marginTop: "0.55rem",
                        height: "14px"
                    }}>
                        {points.map((point, index) => {
                            const leftPct = (point.x / CHART_WIDTH) * 100;
                            const showLabel = index % showEveryNthLabel === 0 || index === points.length - 1;

                            return (
                                <div
                                    key={`${point.row.bucket}-label`}
                                    style={{
                                        position: "absolute",
                                        left: `${leftPct}%`,
                                        transform: "translateX(-50%)",
                                        minWidth: 0,
                                        maxWidth: "72px",
                                        fontSize: "0.62rem",
                                        color: hoverState?.activeIndex === point.index ? "#93c5fd" : "var(--app-text-ghost)",
                                        textAlign: "center",
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        visibility: showLabel ? "visible" : "hidden",
                                        transition: "color 0.15s ease"
                                    }}
                                >
                                    {point.row.label}
                                </div>
                            );
                        })}
                        {nowPoint && (
                            <div
                                style={{
                                    position: "absolute",
                                    left: `${(nowX / CHART_WIDTH) * 100}%`,
                                    transform: "translateX(-50%)",
                                    fontSize: "0.62rem",
                                    color: hoverState?.activeIndex === nowPoint.index ? "#93c5fd" : "var(--app-text-ghost)",
                                    whiteSpace: "nowrap",
                                    transition: "color 0.15s ease"
                                }}
                            >
                                Now
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
