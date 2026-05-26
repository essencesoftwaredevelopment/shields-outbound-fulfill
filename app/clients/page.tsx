"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useAgencyId } from "@/lib/hooks/useAgencyId";
import { apiFetch, apiJson } from "@/lib/api/http";
import { getAccessToken } from "@/lib/supabase/session";
import { getPipelineBaseUrl } from "@/lib/pipeline/client";
import AppShell from "@/components/app-shell";

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
    const { agencyId } = useAgencyId();
    const [clients, setClients] = useState<Array<{ id: string; name: string; activeCampaigns?: number }>>([]);
    const [campaignCounts, setCampaignCounts] = useState<Record<string, number>>({});
    const [selectedClientId, setSelectedClientId] = useState<string>("");
    const [selectedClient, setSelectedClient] = useState<{ id: string; name: string; totalLeads?: number; instantly_key?: string; industry?: string } | null>(null);
    const [campaigns, setCampaigns] = useState<Array<{ id: string; name: string; status?: string; createdAt?: string }>>([]);
    const [syncingCampaigns, setSyncingCampaigns] = useState(false);
    const [syncMessage, setSyncMessage] = useState<string>("");
    const [companyCountsByClient, setCompanyCountsByClient] = useState<Record<string, number>>({});
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
        if (!agencyId || !selectedClientId) return "";
        return `https://api.shieldsoutboundserver.org/webhook/instantly/events/${agencyId}/${selectedClientId}`;
    }, [agencyId, selectedClientId]);

    useEffect(() => {
        if (!loading && !user) {
            router.replace("/auth");
        }
    }, [loading, user, router]);

    const clientIdsKey = useMemo(
        () => clients.map((c) => c.id).filter(Boolean).sort().join(","),
        [clients]
    );

    useEffect(() => {
        if (!user?.id) {
            setClients([]);
            setCompanyCountsByClient({});
            return;
        }
        let cancelled = false;

        (async () => {
            try {
                const data = await apiJson<{ clients: Array<{ id: string; name: string }> }>("/api/clients");
                if (cancelled) return;
                const rows = (data.clients || []).map((c) => ({
                    id: c.id,
                    name: c.name || c.id,
                    activeCampaigns: 0,
                }));
                setClients(rows);
            } catch {
                if (!cancelled) setClients([]);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [user?.id]);

    useEffect(() => {
        if (!user?.id || !clientIdsKey) {
            setCompanyCountsByClient({});
            return;
        }
        let cancelled = false;

        (async () => {
            try {
                const token = await getAccessToken();
                if (!token || cancelled) return;
                const params = new URLSearchParams({ clientIds: clientIdsKey });
                const response = await fetchWithRetry(
                    `${getPipelineBaseUrl()}/api/stats/companies-counts?${params}`,
                    {
                        headers: {
                            Authorization: `Bearer ${token}`,
                            "Content-Type": "application/json",
                        },
                    }
                );
                if (response.ok && !cancelled) {
                    const data = (await response.json()) as { counts?: Record<string, number> };
                    setCompanyCountsByClient(data.counts || {});
                }
            } catch (error) {
                console.error("Failed to fetch company counts:", error);
                if (!cancelled) setCompanyCountsByClient({});
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [user?.id, clientIdsKey]);

    useEffect(() => {
        if (!selectedClientId) {
            setSelectedClient(null);
            setCampaigns([]);
            return;
        }
        const match = clients.find((c) => c.id === selectedClientId) || null;
        if (match) {
            setSelectedClient((prev) => (prev?.id === match.id ? prev : { ...match }));
        }
    }, [selectedClientId, clients]);

    useEffect(() => {
        if (!user || !selectedClientId || !agencyId) {
            setSelectedClient(null);
            setCampaigns([]);
            return;
        }
        let cancelled = false;

        (async () => {
            try {
                const clientData = await apiJson<{
                    client: {
                        id: string;
                        name: string;
                        industry?: string;
                        instantly_key?: string;
                    };
                }>(`/api/clients/${encodeURIComponent(selectedClientId)}`);

                const campaignsData = await apiFetch(
                    `/api/clients/${encodeURIComponent(selectedClientId)}/campaigns/list?agencyId=${encodeURIComponent(agencyId)}`
                ).then((r) => r.json() as Promise<{ campaigns?: Array<{ id: string | number; name: string; status?: number }> }>);

                if (cancelled) return;

                setSelectedClient({
                    id: selectedClientId,
                    name: clientData.client?.name || selectedClientId,
                    totalLeads: 0,
                    instantly_key: clientData.client?.instantly_key || "",
                    industry: clientData.client?.industry || "",
                });

                const rows = (campaignsData.campaigns || []).map((c) => ({
                    id: String(c.id),
                    name: c.name || String(c.id),
                    status: String(c.status ?? ""),
                    createdAt: "",
                }));
                setCampaigns(rows);

                const activeCount = rows.filter((c) => Number(c.status) === 1).length;
                setCampaignCounts((prev) => ({ ...prev, [selectedClientId]: activeCount }));
            } catch {
                if (!cancelled) {
                    const match = clients.find((c) => c.id === selectedClientId) || null;
                    setSelectedClient(match ? { ...match } : null);
                    setCampaigns([]);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [selectedClientId, user?.id, agencyId, clients]);

    async function handleRefreshCampaigns() {
        if (!user || !selectedClientId) return;
        setSyncingCampaigns(true);
        setSyncMessage("");
        try {
            const resp = await apiFetch(`/api/clients/${encodeURIComponent(selectedClientId)}/campaigns`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
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
                                            <strong className="card-big-data">
                                                {(companyCountsByClient[client.id] ?? 0).toLocaleString()}
                                            </strong>
                                            <br />
                                            companies in database
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
                                background: "var(--app-bg-overlay-soft)",
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
                                                const tone = st === 1 ? 'var(--app-status-active)' : st === 2 ? 'var(--app-status-paused)' : st === 0 ? 'var(--app-status-inactive)' : 'var(--app-status-other)';
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
