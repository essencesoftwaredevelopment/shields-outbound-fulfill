"use client";

import AppShell from "@/components/app-shell";
import { useAuth } from "@/hooks/use-auth";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { firestore } from "@/lib/firebase/firestore";
import { useMemo, useState, useEffect } from "react";

// Helper function to retry fetch on connection errors
async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 2): Promise<Response> {
    const startTime = Date.now();
    console.log(`🌐 [FETCH] Starting request to ${url}`);
    
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await fetch(url, options);
            const duration = Date.now() - startTime;
            console.log(`✅ [FETCH] Success ${url} (${duration}ms, status: ${response.status})`);
            return response;
        } catch (error: any) {
            const duration = Date.now() - startTime;
            console.error(`❌ [FETCH] Attempt ${attempt + 1}/${retries + 1} failed for ${url} (${duration}ms):`, {
                name: error.name,
                message: error.message,
                code: error.code
            });
            
            if (error.message?.includes('ECONNRESET')) {
                console.error('🔥 ECONNRESET ERROR on frontend fetch!');
            }
            
            if (attempt < retries && (error.message?.includes('ECONNRESET') || error.message?.includes('Failed to fetch'))) {
                const backoff = 1000 * (attempt + 1);
                console.warn(`🔄 [FETCH] Retrying in ${backoff}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoff));
                continue;
            }
            
            console.error(`💥 [FETCH] All attempts failed for ${url}`);
            throw error;
        }
    }
    throw new Error('Max retries exceeded');
}

export default function AccountPage() {
    const { user } = useAuth();
    const [checkoutLoading, setCheckoutLoading] = useState(false);
    const [checkoutError, setCheckoutError] = useState<string | null>(null);
    const [emailProvider, setEmailProvider] = useState<string>("trykitt");
    const [providerLoading, setProviderLoading] = useState(false);
    const [providerSaved, setProviderSaved] = useState(false);
    
    const checkoutBaseUrl = useMemo(() => {
        if (typeof window === "undefined") return "";
        const base = process.env.NEXT_PUBLIC_PIPELINE_URL || "";
        if (!base) return "";
        return base.endsWith("/") ? base.slice(0, -1) : base;
    }, []);

    // Load email provider preference on mount
    useEffect(() => {
        async function loadProvider() {
            if (!user) return;
            try {
                const userDocRef = doc(firestore, "users", user.uid);
                const userDoc = await getDoc(userDocRef);
                if (userDoc.exists()) {
                    const data = userDoc.data();
                    setEmailProvider(data?.email_verification_provider || "trykitt");
                }
            } catch (error) {
                console.error("Failed to load email provider preference:", error);
            }
        }
        loadProvider();
    }, [user]);

    const handleSaveProvider = async () => {
        if (!user) return;
        setProviderLoading(true);
        setProviderSaved(false);
        try {
            const userDocRef = doc(firestore, "users", user.uid);
            await updateDoc(userDocRef, {
                email_verification_provider: emailProvider
            });
            setProviderSaved(true);
            setTimeout(() => setProviderSaved(false), 3000);
        } catch (error) {
            console.error("Failed to save email provider preference:", error);
            alert("Failed to save preference. Please try again.");
        } finally {
            setProviderLoading(false);
        }
    };

    const handleSubscribe = async () => {
        if (checkoutLoading) return; // prevent accidental double submission
        setCheckoutError(null);
        setCheckoutLoading(true);
        try {
            if (!user) {
                throw new Error("Please sign in first.");
            }
            const idToken = await user.getIdToken();
            const endpoint = `${checkoutBaseUrl || ""}/api/stripe/checkout`;
            const resp = await fetchWithRetry(endpoint, {
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
                        
                        {/* Email Verification Provider Selection */}
                        <div style={{ marginTop: '3rem', paddingTop: '2rem', borderTop: '1px solid var(--border-color, #e5e7eb)' }}>
                            <h2 style={{ fontSize: '1.5rem', fontWeight: '600', marginBottom: '0.5rem' }}>
                                Email Verification Provider
                            </h2>
                            <p style={{ color: 'var(--text-secondary, #6b7280)', marginBottom: '1.5rem' }}>
                                Choose which service to use for email verification during pipeline runs.
                            </p>
                            
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '520px' }}>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                                    <input
                                        type="radio"
                                        name="emailProvider"
                                        value="trykitt"
                                        checked={emailProvider === "trykitt"}
                                        onChange={(e) => setEmailProvider(e.target.value)}
                                        style={{ width: '18px', height: '18px' }}
                                    />
                                    <div>
                                        <div style={{ fontWeight: '500' }}>TryKitt</div>
                                        <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary, #6b7280)' }}>
                                            Cloud-based email verification service (requires API key in vault)
                                        </div>
                                    </div>
                                </label>
                                
                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
                                    <input
                                        type="radio"
                                        name="emailProvider"
                                        value="self_hosted"
                                        checked={emailProvider === "self_hosted"}
                                        onChange={(e) => setEmailProvider(e.target.value)}
                                        style={{ width: '18px', height: '18px' }}
                                    />
                                    <div>
                                        <div style={{ fontWeight: '500' }}>Self-Hosted Verifier</div>
                                        <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary, #6b7280)' }}>
                                            Use the self-hosted email verification service (no API key required)
                                        </div>
                                    </div>
                                </label>
                                
                                <button
                                    type="button"
                                    className="primary-button"
                                    onClick={handleSaveProvider}
                                    disabled={providerLoading}
                                    style={{ alignSelf: 'flex-start', marginTop: '0.5rem' }}
                                >
                                    {providerLoading ? "Saving..." : "Save Preference"}
                                </button>
                                
                                {providerSaved && (
                                    <p className="vault-status vault-status--success" aria-live="polite">
                                        ✓ Email verification provider saved successfully
                                    </p>
                                )}
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
