"use client";

import { ReactNode, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { usePlatformAdmin } from "@/lib/hooks/usePlatformAdmin";

type ThemeMode = "dark" | "light" | "auto";

const SIDEBAR_WIDTH_EXPANDED = "260px";
const SIDEBAR_WIDTH_COLLAPSED = "64px";

function getEffectiveTheme(): ThemeMode {
    const stored = localStorage.getItem("theme") as ThemeMode | null;
    return stored ?? "auto";
}

function applyTheme(mode: ThemeMode) {
    const root = document.documentElement;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = mode === "dark" || (mode === "auto" && prefersDark);
    root.classList.toggle("dark", isDark);
    root.classList.toggle("light", !isDark);
    if (mode === "auto") {
        localStorage.removeItem("theme");
    } else {
        localStorage.setItem("theme", mode);
    }
}

export default function AppShell({ children }: { children: ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const { isAdmin } = usePlatformAdmin();
    const [today, setToday] = useState<string>("");
    const [themeMode, setThemeMode] = useState<ThemeMode>("auto");
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const isActive = (path: string) => pathname === path || pathname.startsWith(`${path}/`);

    useEffect(() => {
        setToday(new Date().toLocaleDateString());
        setThemeMode(getEffectiveTheme());
        const stored = localStorage.getItem("sidebar-collapsed");
        if (stored === "true") {
            setSidebarCollapsed(true);
        }
    }, []);

    function cycleTheme() {
        const next: ThemeMode = themeMode === "auto" ? "dark" : themeMode === "dark" ? "light" : "auto";
        applyTheme(next);
        setThemeMode(next);
    }

    function toggleSidebar() {
        setSidebarCollapsed((prev) => {
            const next = !prev;
            localStorage.setItem("sidebar-collapsed", String(next));
            return next;
        });
    }

    const themeIcon = themeMode === "dark" ? "🌙" : themeMode === "light" ? "☀️" : "🖥️";
    const themeLabel = themeMode === "dark" ? "Dark" : themeMode === "light" ? "Light" : "Auto";
    const sidebarWidth = sidebarCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;

    return (
        <div
            className="dashboard"
            style={{ "--app-sidebar-width": sidebarWidth } as React.CSSProperties}
        >
            <aside
                className={`sidebar${sidebarCollapsed ? " sidebar--collapsed" : ""}`}
                style={{
                    position: "fixed",
                    top: 0,
                    left: 0,
                    height: "100vh",
                    overflow: "hidden",
                }}
            >
                <button
                    type="button"
                    className="sidebar__toggle"
                    onClick={toggleSidebar}
                    aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                    title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        {sidebarCollapsed ? (
                            <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                        ) : (
                            <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                        )}
                    </svg>
                </button>

                <div className="sidebar__brand">
                    <span className="sidebar__tag">{today}</span>
                </div>

                <div
                    className="sidebar__nav"
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        height: "calc(100vh - 96px)",
                        gap: "0.5rem",
                        justifyContent: "space-between",
                    }}
                >
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                        <button
                            type="button"
                            className={`sidebar__btn${isActive("/") ? " sidebar__btn--active" : ""}`}
                            onClick={() => router.push("/")}
                            title="Home"
                        >
                            <span className="sidebar__btn-icon" aria-hidden="true">🏠</span>
                            <span className="sidebar__btn-label">Home</span>
                        </button>
                        <button
                            type="button"
                            className={`sidebar__btn${isActive("/account") ? " sidebar__btn--active" : ""}`}
                            onClick={() => router.push("/account")}
                            title="Account"
                        >
                            <span className="sidebar__btn-icon" aria-hidden="true">👤</span>
                            <span className="sidebar__btn-label">Account</span>
                        </button>
                        {isAdmin && (
                            <button
                                type="button"
                                className={`sidebar__btn${isActive("/admin") ? " sidebar__btn--active" : ""}`}
                                onClick={() => router.push("/admin")}
                                title="Admin"
                            >
                                <span className="sidebar__btn-icon" aria-hidden="true">🛡️</span>
                                <span className="sidebar__btn-label">Admin</span>
                            </button>
                        )}
                    </div>

                    <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                        <button
                            type="button"
                            className="sidebar__btn"
                            onClick={cycleTheme}
                            title={`Theme: ${themeLabel} — click to cycle`}
                        >
                            <span className="sidebar__btn-icon" aria-hidden="true">{themeIcon}</span>
                            <span className="sidebar__btn-label">{themeLabel}</span>
                        </button>
                        <button
                            type="button"
                            className="sidebar__btn"
                            onClick={() => router.push("/?showKeys=1")}
                            title="Keys"
                        >
                            <span className="sidebar__btn-icon" aria-hidden="true">🔑</span>
                            <span className="sidebar__btn-label">Keys</span>
                        </button>
                        <button
                            type="button"
                            className="sidebar__btn"
                            title="Logout"
                            onClick={async () => {
                                try {
                                    await supabase.auth.signOut();
                                    router.replace("/auth");
                                } catch (err) {
                                    console.warn("Logout failed", err);
                                }
                            }}
                        >
                            <span className="sidebar__btn-icon" aria-hidden="true">🚪</span>
                            <span className="sidebar__btn-label">Logout</span>
                        </button>
                    </div>
                </div>
            </aside>

            <div className="dashboard__inner">
                <div className="dashboard__content">{children}</div>
            </div>
        </div>
    );
}
