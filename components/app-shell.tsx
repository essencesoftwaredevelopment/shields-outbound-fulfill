"use client";

import { ReactNode, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

type ThemeMode = "dark" | "light" | "auto";

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
    const [today, setToday] = useState<string>("");
    const [themeMode, setThemeMode] = useState<ThemeMode>("auto");
    const isActive = (path: string) => pathname === path || pathname.startsWith(`${path}/`);

    useEffect(() => {
        setToday(new Date().toLocaleDateString());
        setThemeMode(getEffectiveTheme());
    }, []);

    function cycleTheme() {
        const next: ThemeMode = themeMode === "auto" ? "dark" : themeMode === "dark" ? "light" : "auto";
        applyTheme(next);
        setThemeMode(next);
    }

    const themeIcon = themeMode === "dark" ? "🌙" : themeMode === "light" ? "☀️" : "🖥️";
    const themeLabel = themeMode === "dark" ? "Dark" : themeMode === "light" ? "Light" : "Auto";

    return (
        <div className="dashboard">
            <aside
                className="sidebar"
                style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    height: '100vh',
                    overflow: 'hidden',
                }}
            >
                <div className="sidebar__brand">
                    <span className="sidebar__tag">{today}</span>
                </div>
                <div
                    className="sidebar__nav"
                    style={{
                        display: 'flex',
                        flexDirection: 'column',
                        height: 'calc(100vh - 64px)',
                        gap: '0.5rem',
                    justifyContent: 'space-between',
                }}
            >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <button
                        type="button"
                        className={`sidebar__btn${isActive('/') ? ' sidebar__btn--active' : ''}`}
                        onClick={() => router.push('/')}
                    >
                        🏠  Home
                    </button>
                    <button
                        type="button"
                        className={`sidebar__btn${isActive('/account') ? ' sidebar__btn--active' : ''}`}
                        onClick={() => router.push('/account')}
                    >
                        👤  Account
                    </button>
                </div>
                <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <button
                        type="button"
                        className="sidebar__btn"                        onClick={cycleTheme}
                        title={`Theme: ${themeLabel} — click to cycle`}
                    >
                        {themeIcon}  {themeLabel}
                    </button>
                    <button
                        type="button"
                        className="sidebar__btn"                            onClick={() => router.push('/?showKeys=1')}
                        >
                            🔑  Keys
                        </button>
                        <button
                            type="button"
                            className="sidebar__btn"
                            onClick={async () => {
                                try {
                                    await supabase.auth.signOut();
                                    router.replace('/auth');
                                } catch (err) {
                                    console.warn('Logout failed', err);
                                }
                            }}
                        >
                            🚪  Logout
                        </button>
                    </div>
                </div>
            </aside>

            <div className="dashboard__inner" style={{ marginLeft: '260px' }}>
                <div className="dashboard__content">{children}</div>
            </div>
        </div>
    );
}
