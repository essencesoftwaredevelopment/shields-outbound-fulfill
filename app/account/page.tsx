"use client";

import AppShell from "@/components/app-shell";
import { useAuth } from "@/hooks/use-auth";
import { useMemo, useState } from "react";

export default function AccountPage() {
    const { user } = useAuth();
    const [checkoutLoading, setCheckoutLoading] = useState(false);
    const [checkoutError, setCheckoutError] = useState<string | null>(null);
    const checkoutBaseUrl = useMemo(() => {
        if (typeof window === "undefined") return "";
        const base = process.env.NEXT_PUBLIC_PIPELINE_URL || "";
        if (!base) return "";
        return base.endsWith("/") ? base.slice(0, -1) : base;
    }, []);

    const handleSubscribe = async () => {
        setCheckoutError(null);
        setCheckoutLoading(true);
        try {
            if (!user) {
                throw new Error("Please sign in first.");
            }
            const idToken = await user.getIdToken();
            const endpoint = `${checkoutBaseUrl || ""}/api/stripe/checkout`;
            const resp = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ idToken }),
            });
            const data = await resp.json();
            if (!resp.ok || !data?.url) {
                throw new Error(data?.error || "Unable to start checkout.");
            }
            window.location.href = data.url as string;
        } catch (error) {
            const message = error instanceof Error ? error.message : "Checkout failed.";
            setCheckoutError(message);
        } finally {
            setCheckoutLoading(false);
        }
    };

    return (
        <AppShell>
            <section className="hero-panel" style={{ alignItems: 'flex-start', textAlign: 'left' }}>
                <div className="hero-panel__layout" style={{ alignItems: 'flex-start', justifyContent: 'flex-start' }}>
                    <div className="hero-panel__content" style={{ textAlign: 'left', maxWidth: '720px' }}>
                        <p className="eyebrow">Account</p>
                        <h1 className="hero-panel__title">Profile & Billing</h1>
                        <p className="hero-panel__description">
                            View your login details and manage your session.
                        </p>
                        <div className="account-metric-grid">
                            <div className="account-metric-chip">
                                <span className="account-metric-chip__label">Signed in as</span>
                                <span className="account-metric-chip__value">{user?.email || '—'}</span>
                            </div>
                            <div className="account-metric-chip">
                                <span className="account-metric-chip__label">UID</span>
                                <span className="account-metric-chip__value">
                                    {user?.uid || '—'}
                                </span>
                            </div>
                        </div>
                        <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            <button
                                type="button"
                                className="primary-button"
                                onClick={handleSubscribe}
                                disabled={checkoutLoading}
                                aria-busy={checkoutLoading}
                                style={{ alignSelf: 'flex-start' }}
                            >
                                {checkoutLoading ? "Redirecting..." : "Subscribe with Stripe"}
                            </button>
                            {checkoutError && (
                                <p className="vault-status vault-status--error" aria-live="polite" style={{ maxWidth: '520px' }}>
                                    {checkoutError}
                                </p>
                            )}
                            {!checkoutError && (
                                <p className="hero-panel__subtitle" style={{ maxWidth: '520px' }}>
                                    Start a subscription to unlock full access. You will be redirected to Stripe Checkout.
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </section>
        </AppShell>
    );
}
