"use client";

import { useEffect, useRef } from "react";

/**
 * Runs callback on an interval only while the document tab is visible.
 * Also runs once when the tab becomes visible again.
 */
export function useIntervalWhenVisible(callback: () => void, intervalMs: number, enabled = true) {
    const callbackRef = useRef(callback);
    callbackRef.current = callback;

    useEffect(() => {
        if (!enabled || intervalMs <= 0) return;

        const tick = () => {
            if (document.visibilityState === "visible") {
                callbackRef.current();
            }
        };

        tick();
        const timer = window.setInterval(tick, intervalMs);
        const onVisibility = () => {
            if (document.visibilityState === "visible") {
                tick();
            }
        };
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [enabled, intervalMs]);
}
