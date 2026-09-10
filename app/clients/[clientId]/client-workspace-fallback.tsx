"use client";

import Link from "next/link";
import AppShell from "@/components/app-shell";

const TABS = ["Analytics", "Pipeline", "All Leads", "Follow-Ups", "Info"] as const;

function StatCardSkeleton() {
    return (
        <div
            style={{
                padding: "1.35rem 1.2rem",
                borderRadius: "16px",
                border: "1px solid var(--app-border-mid)",
            }}
        >
            <div className="analytics-skeleton" style={{ width: "72px", height: "48px" }} />
            <div className="analytics-skeleton" style={{ width: "88px", height: "22px", marginTop: "0.45rem" }} />
            <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", marginTop: "0.55rem" }}>
                <div className="analytics-skeleton" style={{ width: "18px", height: "18px", borderRadius: "999px", flexShrink: 0 }} />
                <div className="analytics-skeleton" style={{ width: "112px", height: "14px" }} />
            </div>
        </div>
    );
}

export function ClientWorkspaceFallback() {
    return (
        <AppShell>
            <section className="hero-panel client-workspace" aria-busy="true" aria-live="polite">
                <header className="client-page-header">
                    <Link href="/" className="page-back">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Back
                    </Link>
                    <h1 className="client-page-header__title">
                        <span className="sr-only">Loading client</span>
                        <span className="analytics-skeleton" style={{ display: "block", width: "11rem", height: "1.5rem" }} aria-hidden="true" />
                    </h1>
                    <p className="client-page-header__description">Manage campaigns and view leads for this client.</p>
                </header>

                <div className="tab-nav" aria-hidden="true">
                    {TABS.map((label, index) => (
                        <span
                            key={label}
                            className={`tab-nav__button${index === 0 ? " tab-nav__button--active" : ""}`}
                        >
                            {label}
                        </span>
                    ))}
                </div>

                <div style={{ marginTop: "2rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                        <div className="analytics-skeleton" style={{ width: "9rem", height: "2rem" }} />
                        <div className="analytics-skeleton" style={{ width: "4.5rem", height: "1.75rem", borderRadius: "999px" }} />
                        <div style={{ display: "flex", gap: "0.75rem", marginLeft: "auto", flexWrap: "wrap" }}>
                            <div className="analytics-skeleton" style={{ width: "14rem", height: "2.5rem" }} />
                            <div className="analytics-skeleton" style={{ width: "11rem", height: "2.5rem" }} />
                            <div className="analytics-skeleton" style={{ width: "11rem", height: "2.5rem" }} />
                        </div>
                    </div>

                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                            gap: "1rem",
                        }}
                    >
                        {Array.from({ length: 5 }, (_, index) => (
                            <StatCardSkeleton key={index} />
                        ))}
                    </div>
                </div>
            </section>
        </AppShell>
    );
}
