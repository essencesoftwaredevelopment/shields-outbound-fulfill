"use client";

import { useEffect, useRef, useState } from "react";

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

type AnimatedNumberProps = {
    value: number;
    /** Fraction digits in the rendered number (default 0 — whole numbers). */
    decimals?: number;
    /** Rendered inside the same text node, e.g. "$". */
    prefix?: string;
    /** Animation length in ms per value change. */
    durationMs?: number;
};

/**
 * Renders a number that counts from its previously displayed value to the new
 * one whenever `value` changes (either direction). First render shows the
 * value immediately — only CHANGES animate, so page loads don't spin every
 * counter up from zero. A change arriving mid-animation retargets from the
 * currently displayed value, so polling updates stay smooth. Honors
 * prefers-reduced-motion by snapping.
 *
 * tabular-nums keeps the digits from jiggling horizontally while counting.
 */
export function AnimatedNumber({
    value,
    decimals = 0,
    prefix = "",
    durationMs = 750,
}: AnimatedNumberProps) {
    const [display, setDisplay] = useState(value);
    const displayRef = useRef(value);
    const frameRef = useRef<number | null>(null);

    useEffect(() => {
        const from = displayRef.current;
        const to = value;

        const snap = () => {
            displayRef.current = to;
            setDisplay(to);
        };

        if (!Number.isFinite(to) || from === to) {
            snap();
            return;
        }
        if (
            typeof window === "undefined"
            || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
        ) {
            snap();
            return;
        }

        const startedAt = performance.now();
        const tick = (now: number) => {
            const t = Math.min((now - startedAt) / durationMs, 1);
            const next = t >= 1 ? to : from + (to - from) * easeOutCubic(t);
            displayRef.current = next;
            setDisplay(next);
            frameRef.current = t < 1 ? requestAnimationFrame(tick) : null;
        };
        frameRef.current = requestAnimationFrame(tick);

        return () => {
            if (frameRef.current !== null) {
                cancelAnimationFrame(frameRef.current);
                frameRef.current = null;
            }
        };
    }, [value, durationMs]);

    const formatted = Number.isFinite(display)
        ? display.toLocaleString(undefined, {
              minimumFractionDigits: decimals,
              maximumFractionDigits: decimals,
          })
        : "—";

    return (
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {prefix}
            {formatted}
        </span>
    );
}
