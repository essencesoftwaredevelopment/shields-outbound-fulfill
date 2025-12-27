"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { collection, getDocs, onSnapshot, doc, getDoc } from "firebase/firestore";
import { getIdToken } from "firebase/auth";
import { firebaseAuth } from "@/lib/firebase/auth";
import { useAuth } from "@/hooks/use-auth";
import { firestore } from "@/lib/firebase/firestore";
import AppShell from "@/components/app-shell";

type Niche = {
    id: string;
    label: string;
    detail: string;
    icon: string;
};

export default function ClientsPage() {
    const router = useRouter();
    const pathname = usePathname();
    const { user, loading } = useAuth();
    const [clients, setClients] = useState<Array<{ id: string; name: string; activeCampaigns?: number }>>([]);
    const [campaignCounts, setCampaignCounts] = useState<Record<string, number>>({});
    const campaignUnsubsRef = useState<Record<string, () => void>>({})[0];
    const [selectedClientId, setSelectedClientId] = useState<string>("");
    const [selectedClient, setSelectedClient] = useState<{ id: string; name: string; totalLeads?: number; instantly_key?: string; industry?: string } | null>(null);
    const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string; status?: string; createdAt?: string }>>([]);
    const [syncingCampaigns, setSyncingCampaigns] = useState(false);
    const [syncMessage, setSyncMessage] = useState<string>("");
    const modalRef = useRef<HTMLDivElement>(null);

    const niches = useMemo<Niche[]>(
        () => [
            { id: "ecom", label: "E-commerce", detail: "Shopify optimized", icon: "🛍️" },
            { id: "saas", label: "SaaS", detail: "B2B tech focus", icon: "🌐" },
            { id: "agency", label: "Agency", detail: "Service business focus", icon: "🏢" },
            { id: "local", label: "Local Biz", detail: "Geo-specific focus", icon: "🔧" },
        ],
        []
    );

    const instantlyWebhookUrl = useMemo(() => {
        if (!user || !selectedClientId) return "";
        return `https://api.shieldsoutboundserver.org/webhook/events/${user.uid}/${selectedClientId}`;
    }, [user, selectedClientId]);

    useEffect(() => {
        if (!loading && !user) {
            router.replace("/auth");
        }
    }, [loading, user, router]);

    useEffect(() => {
        if (!user) {
            setClients([]);
            // cleanup campaign listeners
            Object.values(campaignUnsubsRef).forEach(unsub => { try { unsub(); } catch { } });
            Object.keys(campaignUnsubsRef).forEach(k => delete campaignUnsubsRef[k]);
            return;
        }
        let cancelled = false;

        const colRef = collection(firestore, "users", user.uid, "clients");

        const unsubscribe = onSnapshot(
            colRef,
            (snap) => {
                if (cancelled) return;
                const rows = snap.docs.map((d) => ({
                    id: d.id,
                    name: (d.data().name as string) || d.id,
                    activeCampaigns: (d.data().activeCampaigns as number) || 0,
                }));
                setClients(rows);
                // keep selection in sync if present
                if (selectedClientId) {
                    const match = rows.find(r => r.id === selectedClientId) || null;
                    setSelectedClient(match ? { ...match } : null);
                }
                // wire up per-client campaigns listeners to compute active counts in real time
                rows.forEach((row) => {
                    if (campaignUnsubsRef[row.id]) return; // already listening
                    const col = collection(firestore, "users", user.uid, "clients", row.id, "campaigns");
                    const unsub = onSnapshot(col, (csnap) => {
                        if (cancelled) return;
                        let count = 0;
                        csnap.docs.forEach((doc) => {
                            const st = doc.data().status;
                            if (Number(st) === 1) count += 1;
                        });
                        setCampaignCounts((prev) => ({ ...prev, [row.id]: count }));
                    }, () => {
                        if (!cancelled) setCampaignCounts((prev) => ({ ...prev, [row.id]: 0 }));
                    });
                    campaignUnsubsRef[row.id] = unsub;
                });
            },
            () => {
                if (!cancelled) setClients([]);
            }
        );

        (async () => {
            try {
                const snap = await getDocs(colRef);
                if (!cancelled) {
                    const rows = snap.docs.map((d) => ({
                        id: d.id,
                        name: (d.data().name as string) || d.id,
                        activeCampaigns: (d.data().activeCampaigns as number) || 0,
                    }));
                    setClients(rows);
                    if (selectedClientId) {
                        const match = rows.find(r => r.id === selectedClientId) || null;
                        setSelectedClient(match ? { ...match } : null);
                    }
                }
            } catch {
                if (!cancelled) setClients([]);
            }
        })();

        return () => {
            cancelled = true;
            try { unsubscribe(); } catch { }
            // cleanup campaign listeners
            Object.values(campaignUnsubsRef).forEach(unsub => { try { unsub(); } catch { } });
            Object.keys(campaignUnsubsRef).forEach(k => delete campaignUnsubsRef[k]);
        };
    }, [user]);

    // Load full selected client details when selected
    useEffect(() => {
        if (!user || !selectedClientId) {
            setSelectedClient(null);
            setCampaigns([]);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const ref = doc(firestore, "users", user.uid, "clients", selectedClientId);
                const snap = await getDoc(ref);
                if (!cancelled) {
                    const data = snap.data() || {};
                    setSelectedClient({
                        id: selectedClientId,
                        name: (data.name as string) || selectedClientId,
                        totalLeads: (data.totalLeads as number) || 0,
                        instantly_key: (data.instantly_key as string) || "",
                        industry: (data.industry as string) || "",
                    });
                }
            } catch {
                if (!cancelled) {
                    const match = clients.find(c => c.id === selectedClientId) || null;
                    setSelectedClient(match ? { ...match } : null);
                }
            }
        })();
        // subscribe to campaigns subcollection
        const campaignsCol = collection(firestore, "users", user.uid, "clients", selectedClientId, "campaigns");
        const unsub = onSnapshot(campaignsCol, (snap) => {
            if (cancelled) return;
            const rows = snap.docs.map((d) => ({
                id: d.id,
                name: (d.data().name as string) || d.id,
                status: (d.data().status as string) || "",
                createdAt: (d.data().createdAt as string) || ""
            }));
            setCampaigns(rows);
        }, () => {
            if (!cancelled) setCampaigns([]);
        });
        return () => { cancelled = true; };
    }, [selectedClientId, user]);

    async function handleRefreshCampaigns() {
        if (!user || !selectedClientId) return;
        setSyncingCampaigns(true);
        setSyncMessage("");
        try {
            const currentUser = firebaseAuth.currentUser;
            const idToken = currentUser ? await getIdToken(currentUser) : null;
            if (!idToken) throw new Error("Missing auth token");
            const resp = await fetch(`/api/clients/${encodeURIComponent(selectedClientId)}/campaigns`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken })
            });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.error || `Sync failed (${resp.status})`);
            }
            const data = await resp.json();
            setSyncMessage(`Synced ${data.count ?? campaigns.length} campaigns.`);
        } catch (err) {
            setSyncMessage(err instanceof Error ? err.message : 'Failed to refresh campaigns');
        } finally {
            setSyncingCampaigns(false);
        }
    }

    // Removed animated count-up; show live values directly

    if (loading || !user) {
        return (
            <div className="auth-gate">
                <p className="eyebrow">Shield&apos;s Outbound</p>
                <h2>Checking access...</h2>
                <p className="auth-card__subtitle">Hang tight while we confirm your session.</p>
            </div>
        );
    }

    return (
        <AppShell>
            <section className="hero-panel">
                <div className="hero-panel__layout">
                    <div className="hero-panel__content">
                        <p className="eyebrow">Clients</p>
                        <h1 className="hero-panel__title">All Clients</h1>
                        <p className="hero-panel__description">
                            Browse all client accounts.
                        </p>
                    </div>
                </div>
                <div className="niche-grid">
                    {clients.length === 0 ? (
                        <div className="pipeline-panel__empty">
                            <p>No clients yet.</p>
                            <p className="pipeline-panel__subtitle">Use Create Client on Home to add one.</p>
                        </div>
                    ) : (
                        clients.map((client) => (
                            <div key={client.id} className="niche-card" style={{ position: "relative" }}>
                                <button
                                    type="button"
                                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedClientId(client.id); }}
                                    style={{ border: "none", background: "none", padding: 0, width: "100%", textAlign: "left", cursor: "pointer" }}
                                >
                                    <span className="niche-card__icon" aria-hidden>
                                        👤
                                    </span>
                                    <div className="niche-card__text">
                                        <p className="niche-card__label">{client.name}</p>
                                        <p className="niche-card__detail">
                                            <strong className="card-big-data">{(campaignCounts[client.id] ?? client.activeCampaigns ?? 0).toLocaleString()}</strong>
                                            <br />
                                            active campaigns
                                        </p>
                                    </div>
                                    <span className="niche-card__cta">View details →</span>
                                </button>
                            </div>
                        ))
                    )}
                </div>

                {selectedClient && (
                    <>
                        <div
                            onClick={() => setSelectedClientId("")}
                            style={{
                                position: "fixed",
                                inset: 0,
                                background: "rgba(0, 0, 0, 0.3)",
                                zIndex: 40
                            }}
                        />
                        <div
                            ref={modalRef}
                            className="modal"
                            onClick={(e) => e.stopPropagation()}
                            style={{
                                maxWidth: "520px",
                                position: "fixed",
                                right: 24,
                                top: 24,
                                bottom: 24,
                                overflow: "auto",
                                zIndex: 50
                            }}
                        >
                            <div className="modal__header">
                                <div>
                                    <p className="eyebrow eyebrow--muted">Selected</p>
                                    <h2 className="modal__title">{selectedClient.name}</h2>
                                    <p className="modal__description">View client information.</p>
                                </div>
                            </div>
                            <div className="modal__body">
                                <label className="label">
                                    Industry
                                    <input className="input" type="text" value={selectedClient.industry || ""} readOnly />
                                </label>
                                <label className="label">
                                    Instantly API Key
                                    <input className="input" type="text" value={selectedClient.instantly_key || ""} readOnly />
                                </label>
                                <label className="label">
                                    Active Campaigns
                                    <input
                                        className="input"
                                        type="text"
                                        value={(campaignCounts[selectedClient.id] ?? 0).toLocaleString()}
                                        readOnly
                                    />
                                </label>
                                <label className="label">
                                    Instantly Webhook URL
                                    <input
                                        className="input"
                                        type="text"
                                        value={instantlyWebhookUrl}
                                        readOnly
                                    />
                                    <p className="pipeline-panel__subtitle" style={{ marginTop: '0.35rem' }}>
                                        Paste this into Instantly to send events for this client.
                                    </p>
                                </label>
                                <div className="modal__actions" style={{ gap: "0.75rem", marginTop: '0.5rem' }}>
                                    <button type="button" className="primary-button" onClick={() => setSelectedClientId("")}>Back to Clients</button>
                                    {/* <button type="button" className="primary-button" onClick={() => router.push("/")}>Go Home</button> */}
                                </div>
                                <hr style={{ margin: '1rem 0', border: 0, borderTop: '1px solid var(--border)' }} />
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                    <button type="button" className="primary-button" onClick={handleRefreshCampaigns} disabled={syncingCampaigns}>
                                        {syncingCampaigns ? 'Refreshing…' : 'Refresh Campaigns'}
                                    </button>
                                    {syncMessage && <span className="eyebrow eyebrow--muted" aria-live="polite">{syncMessage}</span>}
                                </div>
                                <div style={{ marginTop: '1rem' }}>
                                    <p className="eyebrow">Campaigns</p>
                                    {campaigns.length === 0 ? (
                                        <p className="pipeline-panel__subtitle">No campaigns found.</p>
                                    ) : (
                                        <ul className="list" style={{ maxHeight: '280px', overflow: 'auto' }}>
                                            {[
                                                ...campaigns
                                                    .slice()
                                                    .sort((a, b) => {
                                                        // Active campaigns (status === "1" or status === 1) first
                                                        const aStatus = String(a.status || "0");
                                                        const bStatus = String(b.status || "0");
                                                        const aActive = aStatus === "1" ? 1 : 0;
                                                        const bActive = bStatus === "1" ? 1 : 0;
                                                        if (aActive !== bActive) {
                                                            return bActive - aActive;
                                                        }
                                                        // Secondary sort by status number (higher first)
                                                        return Number(bStatus) - Number(aStatus);
                                                    })
                                            ].map(c => {
                                                const st = Number(c.status ?? 0);
                                                const tone = st === 1 ? '#16a34a' : st === 2 ? '#2563eb' : st === 0 ? '#a1a1aa' : '#f59e0b';
                                                const label = st === 1 ? 'Active' : st === 2 ? 'Paused' : st === 0 ? 'Inactive' : `Status ${st}`;
                                                return (
                                                    <li key={c.id} className="list__item" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                        <span
                                                            style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 9999, background: tone }}
                                                            aria-hidden
                                                        />
                                                        <span style={{ flex: 1 }}>{c.name}</span>
                                                        <span style={{ fontSize: '0.875rem', color: tone }}>{label}</span>
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </section>
        </AppShell>
    );
}
