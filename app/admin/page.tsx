"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/app-shell";
import { useAuth } from "@/hooks/use-auth";
import { usePlatformAdmin } from "@/lib/hooks/usePlatformAdmin";
import { apiJson } from "@/lib/api/http";
import { FeatureFlagsEditor } from "@/components/feature-flags/FeatureFlagsEditor";

const MIN_PASSWORD_LENGTH = 8;

type AgencyRow = {
    supabaseUserId: string;
    email: string | null;
    agencyId: string;
    emailConfirmed: boolean;
    createdAt: string | null;
    lastSignInAt: string | null;
    note: string | null;
    clientCount: number;
};

export default function AdminPage() {
    const router = useRouter();
    const { user, loading: authLoading } = useAuth();
    const { isAdmin, loading: adminLoading } = usePlatformAdmin();
    const [agencies, setAgencies] = useState<AgencyRow[]>([]);
    const [listLoading, setListLoading] = useState(true);
    const [listError, setListError] = useState<string | null>(null);

    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [legacyAgencyId, setLegacyAgencyId] = useState("");
    const [note, setNote] = useState("");
    const [skipEmailConfirmation, setSkipEmailConfirmation] = useState(true);
    const [creating, setCreating] = useState(false);
    const [createError, setCreateError] = useState<string | null>(null);
    const [createSuccess, setCreateSuccess] = useState<string | null>(null);
    const [featuresAgency, setFeaturesAgency] = useState<AgencyRow | null>(null);

    useEffect(() => {
        if (authLoading || adminLoading) return;
        if (!user) {
            router.replace("/auth");
            return;
        }
        if (!isAdmin) {
            router.replace("/");
        }
    }, [user, authLoading, adminLoading, isAdmin, router]);

    async function loadAgencies() {
        setListLoading(true);
        setListError(null);
        try {
            const data = await apiJson<{ agencies: AgencyRow[] }>("/api/admin/agencies");
            setAgencies(data.agencies || []);
        } catch (error) {
            setListError(error instanceof Error ? error.message : "Failed to load agencies");
        } finally {
            setListLoading(false);
        }
    }

    useEffect(() => {
        if (!isAdmin) return;
        void loadAgencies();
    }, [isAdmin]);

    const handleCreateAgency = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setCreateError(null);
        setCreateSuccess(null);

        if (password.length < MIN_PASSWORD_LENGTH) {
            setCreateError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
            return;
        }
        if (password !== confirmPassword) {
            setCreateError("Passwords do not match.");
            return;
        }

        setCreating(true);
        try {
            const result = await apiJson<{
                email: string;
                agencyId: string;
                supabaseUserId: string;
            }>("/api/admin/agencies", {
                method: "POST",
                body: JSON.stringify({
                    email: email.trim(),
                    password,
                    legacyAgencyId: legacyAgencyId.trim() || undefined,
                    note: note.trim() || undefined,
                    skipEmailConfirmation,
                }),
            });
            setCreateSuccess(`Created agency account for ${result.email} (agency ID: ${result.agencyId}).`);
            setEmail("");
            setPassword("");
            setConfirmPassword("");
            setLegacyAgencyId("");
            setNote("");
            await loadAgencies();
        } catch (error) {
            setCreateError(error instanceof Error ? error.message : "Failed to create agency account");
        } finally {
            setCreating(false);
        }
    };

    if (authLoading || adminLoading || !isAdmin) {
        return (
            <div className="auth-gate">
                <div className="spinner" aria-hidden="true">
                    ⏳
                </div>
                <p>Loading admin panel…</p>
            </div>
        );
    }

    return (
        <AppShell>
            <section className="hero-panel" style={{ alignItems: "flex-start", textAlign: "left" }}>
                <div className="hero-panel__layout" style={{ alignItems: "flex-start", justifyContent: "flex-start" }}>
                    <div className="hero-panel__content" style={{ textAlign: "left", maxWidth: "960px", width: "100%" }}>
                        <p className="eyebrow">Platform Admin</p>
                        <h1 className="hero-panel__title">Agency Accounts</h1>
                        <p className="hero-panel__description">
                            Create new agency logins and review existing accounts. Each agency can manage multiple
                            outbound clients from their dashboard.
                        </p>

                        <div
                            style={{
                                marginTop: "2rem",
                                padding: "1.5rem",
                                borderRadius: "20px",
                                border: "1px solid var(--app-border-mid)",
                                background: "var(--app-surface-1)",
                            }}
                        >
                            <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.75rem" }}>
                                Create agency account
                            </h2>
                            <p style={{ color: "var(--app-text-muted)", marginBottom: "1.25rem" }}>
                                Provisions a Supabase auth user and initializes agency settings. Use legacy agency ID
                                only when linking an existing Firebase-era tenant.
                            </p>

                            {createError && <p className="auth-card__error">{createError}</p>}
                            {createSuccess && <p className="auth-card__notice">{createSuccess}</p>}

                            <form onSubmit={handleCreateAgency} style={{ display: "grid", gap: "1rem", maxWidth: "520px" }}>
                                <label className="settings-field">
                                    <span className="settings-field__label">Email</span>
                                    <input
                                        type="email"
                                        value={email}
                                        onChange={(event) => setEmail(event.target.value)}
                                        required
                                    />
                                </label>
                                <label className="settings-field">
                                    <span className="settings-field__label">Password</span>
                                    <input
                                        type="password"
                                        value={password}
                                        onChange={(event) => setPassword(event.target.value)}
                                        minLength={MIN_PASSWORD_LENGTH}
                                        required
                                    />
                                </label>
                                <label className="settings-field">
                                    <span className="settings-field__label">Confirm password</span>
                                    <input
                                        type="password"
                                        value={confirmPassword}
                                        onChange={(event) => setConfirmPassword(event.target.value)}
                                        minLength={MIN_PASSWORD_LENGTH}
                                        required
                                    />
                                </label>
                                <label className="settings-field">
                                    <span className="settings-field__label">Legacy agency ID (optional)</span>
                                    <input
                                        type="text"
                                        value={legacyAgencyId}
                                        onChange={(event) => setLegacyAgencyId(event.target.value)}
                                        placeholder="Firebase uid for migrated tenants"
                                    />
                                </label>
                                <label className="settings-field">
                                    <span className="settings-field__label">Note (optional)</span>
                                    <input
                                        type="text"
                                        value={note}
                                        onChange={(event) => setNote(event.target.value)}
                                        placeholder="Internal note for auth map"
                                    />
                                </label>
                                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                                    <input
                                        type="checkbox"
                                        checked={skipEmailConfirmation}
                                        onChange={(event) => setSkipEmailConfirmation(event.target.checked)}
                                    />
                                    <span>Mark email as confirmed (skip confirmation email)</span>
                                </label>
                                <button type="submit" className="primary-button" disabled={creating} style={{ alignSelf: "flex-start" }}>
                                    {creating ? "Creating..." : "Create agency account"}
                                </button>
                            </form>
                        </div>

                        <div style={{ marginTop: "2.5rem" }}>
                            <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.75rem" }}>
                                Existing accounts
                            </h2>
                            {listError && <p className="auth-card__error">{listError}</p>}
                            {listLoading ? (
                                <p style={{ color: "var(--app-text-muted)" }}>Loading agencies…</p>
                            ) : agencies.length === 0 ? (
                                <p style={{ color: "var(--app-text-muted)" }}>No agency accounts found.</p>
                            ) : (
                                <div style={{ overflowX: "auto" }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
                                        <thead>
                                            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--app-border-mid)" }}>
                                                <th style={{ padding: "0.75rem 0.5rem" }}>Email</th>
                                                <th style={{ padding: "0.75rem 0.5rem" }}>Agency ID</th>
                                                <th style={{ padding: "0.75rem 0.5rem" }}>Clients</th>
                                                <th style={{ padding: "0.75rem 0.5rem" }}>Email confirmed</th>
                                                <th style={{ padding: "0.75rem 0.5rem" }}>Note</th>
                                                <th style={{ padding: "0.75rem 0.5rem" }}></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {agencies.map((agency) => (
                                                <tr
                                                    key={agency.supabaseUserId}
                                                    style={{ borderBottom: "1px solid var(--app-border-subtle)" }}
                                                >
                                                    <td style={{ padding: "0.75rem 0.5rem" }}>{agency.email || "—"}</td>
                                                    <td style={{ padding: "0.75rem 0.5rem", fontFamily: "monospace", fontSize: "0.8rem" }}>
                                                        {agency.agencyId}
                                                    </td>
                                                    <td style={{ padding: "0.75rem 0.5rem" }}>{agency.clientCount}</td>
                                                    <td style={{ padding: "0.75rem 0.5rem" }}>
                                                        {agency.emailConfirmed ? "Yes" : "No"}
                                                    </td>
                                                    <td style={{ padding: "0.75rem 0.5rem" }}>{agency.note || "—"}</td>
                                                    <td style={{ padding: "0.75rem 0.5rem", whiteSpace: "nowrap" }}>
                                                        <button
                                                            type="button"
                                                            className="df-btn"
                                                            onClick={() => setFeaturesAgency((prev) => (prev?.agencyId === agency.agencyId ? null : agency))}
                                                            aria-expanded={featuresAgency?.agencyId === agency.agencyId}
                                                        >
                                                            {featuresAgency?.agencyId === agency.agencyId ? "Close features" : "Features"}
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>

                        {featuresAgency && (
                            <div
                                style={{
                                    marginTop: "2rem",
                                    padding: "1.5rem",
                                    borderRadius: "20px",
                                    border: "1px solid var(--app-border-mid)",
                                    background: "var(--app-surface-1)",
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem", marginBottom: "1rem" }}>
                                    <div>
                                        <h2 style={{ fontSize: "1.25rem", fontWeight: 600, marginBottom: "0.25rem" }}>
                                            Features — {featuresAgency.email || featuresAgency.agencyId}
                                        </h2>
                                        <p style={{ color: "var(--app-text-muted)", margin: 0, fontFamily: "monospace", fontSize: "0.8rem" }}>
                                            {featuresAgency.agencyId}
                                        </p>
                                    </div>
                                    <button type="button" className="df-btn df-btn--ghost" onClick={() => setFeaturesAgency(null)}>
                                        Close
                                    </button>
                                </div>
                                <FeatureFlagsEditor key={featuresAgency.agencyId} agencyId={featuresAgency.agencyId} />
                            </div>
                        )}
                    </div>
                </div>
            </section>
        </AppShell>
    );
}
