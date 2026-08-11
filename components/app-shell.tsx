"use client";

import { ReactNode, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
    House,
    KeyRound,
    LogOut,
    Monitor,
    Moon,
    PanelLeftClose,
    PanelLeftOpen,
    Shield,
    Sun,
    User,
} from "lucide-react";
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
    const [themeMode, setThemeMode] = useState<ThemeMode>("auto");
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const isActive = (path: string) => pathname === path || pathname.startsWith(`${path}/`);

    useEffect(() => {
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

    const ThemeIcon = themeMode === "dark" ? Moon : themeMode === "light" ? Sun : Monitor;
    const themeLabel = themeMode === "dark" ? "Dark" : themeMode === "light" ? "Light" : "Auto";
    const sidebarWidth = sidebarCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;

    return (
        <div
            className="dashboard"
            style={{ "--app-sidebar-width": sidebarWidth } as React.CSSProperties}
        >
            <aside className={`sidebar${sidebarCollapsed ? " sidebar--collapsed" : ""}`}>
                <div className="sidebar__header">
                    <div className="sidebar__brand">
                        <span className="sidebar__wordmark">Essence Outbound</span>
                    </div>
                    <button
                        type="button"
                        className="sidebar__toggle"
                        onClick={toggleSidebar}
                        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                    >
                        {sidebarCollapsed ? (
                            <PanelLeftOpen size={16} aria-hidden="true" />
                        ) : (
                            <PanelLeftClose size={16} aria-hidden="true" />
                        )}
                    </button>
                </div>

                <div className="sidebar__nav">
                    <div className="sidebar__nav-group sidebar__nav-group--top">
                        <button
                            type="button"
                            className={`sidebar__btn${isActive("/") ? " sidebar__btn--active" : ""}`}
                            onClick={() => router.push("/")}
                            title="Home"
                        >
                            <span className="sidebar__btn-icon" aria-hidden="true"><House size={18} /></span>
                            <span className="sidebar__btn-label">Home</span>
                        </button>
                        <button
                            type="button"
                            className={`sidebar__btn${isActive("/account") ? " sidebar__btn--active" : ""}`}
                            onClick={() => router.push("/account")}
                            title="Account"
                        >
                            <span className="sidebar__btn-icon" aria-hidden="true"><User size={18} /></span>
                            <span className="sidebar__btn-label">Account</span>
                        </button>
                        {isAdmin && (
                            <button
                                type="button"
                                className={`sidebar__btn${isActive("/admin") ? " sidebar__btn--active" : ""}`}
                                onClick={() => router.push("/admin")}
                                title="Admin"
                            >
                                <span className="sidebar__btn-icon" aria-hidden="true"><Shield size={18} /></span>
                                <span className="sidebar__btn-label">Admin</span>
                            </button>
                        )}
                    </div>

                    <div className="sidebar__nav-group sidebar__nav-group--bottom">
                        <button
                            type="button"
                            className="sidebar__btn"
                            onClick={cycleTheme}
                            title={`Theme: ${themeLabel} — click to cycle`}
                        >
                            <span className="sidebar__btn-icon" aria-hidden="true"><ThemeIcon size={18} /></span>
                            <span className="sidebar__btn-label">{themeLabel}</span>
                        </button>
                        <button
                            type="button"
                            className="sidebar__btn"
                            onClick={() => router.push("/?showKeys=1")}
                            title="Keys"
                        >
                            <span className="sidebar__btn-icon" aria-hidden="true"><KeyRound size={18} /></span>
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
                            <span className="sidebar__btn-icon" aria-hidden="true"><LogOut size={18} /></span>
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
