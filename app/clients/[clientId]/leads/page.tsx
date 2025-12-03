"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { collection, getDocs, onSnapshot, doc, getDoc } from "firebase/firestore";
import { useAuth } from "@/hooks/use-auth";
import { firestore } from "@/lib/firebase/firestore";
import AppShell from "@/components/app-shell";

type Lead = {
    id: string;
    domain?: string;
    email?: string;
    status?: string;
    verified?: boolean;
    firstLine?: string;
    founderName?: string;
    personalizationUrl?: string;
    personalizationTitle?: string;
    updatedAt?: string;
};

export default function ClientLeadsPage() {
    const router = useRouter();
    const params = useParams();
    const clientId = (params?.clientId as string) || "";
    const { user, loading } = useAuth();
    const [clientName, setClientName] = useState<string>(clientId);
    const [leads, setLeads] = useState<Lead[]>([]);
    const [stats, setStats] = useState<{ total: number; verified: number; unverified: number }>(() => ({ total: 0, verified: 0, unverified: 0 }));
    const [selectedLead, setSelectedLead] = useState<Lead | null>(null);

    useEffect(() => {
        if (!loading && !user) {
            router.replace("/auth");
        }
    }, [loading, user, router]);

    useEffect(() => {
        if (!user || !clientId) return;
        let cancelled = false;

        // Load client name
        (async () => {
            try {
                const ref = doc(firestore, "users", user.uid, "clients", clientId);
                const snap = await getDoc(ref);
                if (!cancelled) {
                    const data = snap.data() || {};
                    setClientName((data.name as string) || clientId);
                }
            } catch {
                /* noop */
            }
        })();

        // Subscribe to leads subcollection (first 20 rendered)
        const col = collection(firestore, "users", user.uid, "clients", clientId, "leads");
        const unsub = onSnapshot(col, (snap) => {
            if (cancelled) return;
            const rows = snap.docs.map((d) => {
                const data = d.data();
                const emailStatus = (data.email_status as string) || "";
                const isVerified = emailStatus === "valid" || emailStatus === "verified";
                return {
                    id: d.id,
                    domain: (data.domain as string) || (data.website as string) || "",
                    email: (data.email as string) || "",
                    status: emailStatus,
                    verified: isVerified,
                    firstLine: (data.personalization_first_line as string) || "",
                    founderName: (data.founder_name as string) || "",
                    personalizationUrl: (data.personalization_url as string) || "",
                    personalizationTitle: (data.personalization_title as string) || "",
                    updatedAt: data.updatedAt ? new Date(data.updatedAt.toDate()).toLocaleString() : "",
                } as Lead;
            });
            setLeads(rows);
            const verified = rows.filter((r) => r.verified).length;
            const total = rows.length;
            setStats({ total, verified, unverified: Math.max(0, total - verified) });
        }, () => {
            if (!cancelled) {
                setLeads([]);
                setStats({ total: 0, verified: 0, unverified: 0 });
            }
        });

        return () => {
            cancelled = true;
            try { unsub(); } catch { }
        };
    }, [user, clientId]);

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
        <>
            <AppShell>
                <section className="hero-panel">
                    <div className="hero-panel__layout">
                        <div className="hero-panel__content">
                            <p className="eyebrow">Leads</p>
                            <h1 className="hero-panel__title">{clientName}</h1>
                            <p className="hero-panel__description">Overview of recent leads and stats.</p>
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                        <div className="metric-chip"><span className="metric-chip__label">Total</span><span className="metric-chip__value">{stats.total.toLocaleString()}</span></div>
                        <div className="metric-chip"><span className="metric-chip__label">Verified</span><span className="metric-chip__value" style={{ color: '#16a34a' }}>{stats.verified.toLocaleString()}</span></div>
                        <div className="metric-chip"><span className="metric-chip__label">Unverified</span><span className="metric-chip__value" style={{ color: '#a1a1aa' }}>{stats.unverified.toLocaleString()}</span></div>
                    </div>

                    <div style={{ marginTop: '1.5rem' }}>
                        {leads.length === 0 ? (
                            <div className="pipeline-panel__empty">
                                <p>No leads yet.</p>
                                <p className="pipeline-panel__subtitle">Upload leads to start seeing them here.</p>
                            </div>
                        ) : (
                            <div style={{
                                overflowX: 'auto',
                                border: '1px solid rgba(255, 255, 255, 0.1)',
                                borderRadius: '8px',
                                backgroundColor: 'rgba(0, 0, 0, 0.2)'
                            }}>
                                <table style={{
                                    width: '100%',
                                    borderCollapse: 'collapse',
                                    fontSize: '0.875rem'
                                }}>
                                    <thead>
                                        <tr style={{
                                            backgroundColor: 'rgba(255, 255, 255, 0.05)',
                                            borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
                                        }}>
                                            <th style={{
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                fontWeight: 600,
                                                color: 'rgba(255, 255, 255, 0.9)'
                                            }}>Domain</th>
                                            <th style={{
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                fontWeight: 600,
                                                color: 'rgba(255, 255, 255, 0.9)'
                                            }}>Email</th>
                                            <th style={{
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                fontWeight: 600,
                                                color: 'rgba(255, 255, 255, 0.9)'
                                            }}>Status</th>
                                            <th style={{
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                fontWeight: 600,
                                                color: 'rgba(255, 255, 255, 0.9)'
                                            }}>Verified</th>
                                            <th style={{
                                                textAlign: 'left',
                                                padding: '0.75rem 1rem',
                                                fontWeight: 600,
                                                color: 'rgba(255, 255, 255, 0.9)'
                                            }}>First Line</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {leads.slice(0, 20).map((lead, index) => (
                                            <tr
                                                key={lead.id}
                                                onClick={() => setSelectedLead(lead)}
                                                style={{
                                                    backgroundColor: index % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.03)',
                                                    borderBottom: index < 19 && index < leads.length - 1 ? '1px solid rgba(255, 255, 255, 0.05)' : 'none',
                                                    cursor: 'pointer',
                                                    transition: 'background-color 0.15s ease'
                                                }}
                                                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.08)'}
                                                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = index % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.03)'}
                                            >
                                                <td style={{
                                                    padding: '0.75rem 1rem',
                                                    maxWidth: '200px',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap'
                                                }}>{lead.domain || '—'}</td>
                                                <td style={{
                                                    padding: '0.75rem 1rem',
                                                    maxWidth: '250px',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap'
                                                }}>{lead.email || '—'}</td>
                                                <td style={{
                                                    padding: '0.75rem 1rem',
                                                    maxWidth: '120px',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap'
                                                }}>{lead.status || '—'}</td>
                                                <td style={{
                                                    padding: '0.75rem 1rem',
                                                    color: lead.verified ? '#16a34a' : 'rgba(255, 255, 255, 0.5)'
                                                }}>{lead.verified ? 'Yes' : 'No'}</td>
                                                <td style={{
                                                    padding: '0.75rem 1rem',
                                                    maxWidth: '400px',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    whiteSpace: 'nowrap',
                                                    fontStyle: lead.firstLine ? 'italic' : 'normal',
                                                    color: lead.firstLine ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.3)'
                                                }}>{lead.firstLine || '—'}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </section>
            </AppShell>

            {/* Side panel for lead details */}
            {selectedLead && (
                <>
                    <div
                        className="modal-overlay"
                        role="dialog"
                        aria-modal="true"
                        onClick={() => setSelectedLead(null)}
                        style={{ zIndex: 10000 }}
                    />
                    <div
                        className="modal"
                        style={{
                            position: 'fixed',
                            top: 0,
                            right: 0,
                            bottom: 0,
                            width: '480px',
                            maxWidth: '90vw',
                            height: '100vh',
                            maxHeight: 'none',
                            margin: 0,
                            borderRadius: '0',
                            transform: 'translateX(0)',
                            opacity: 1,
                            overflowY: 'auto',
                            zIndex: 10001,
                            animation: 'slideInFromRight 0.25s ease-out'
                        }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <style jsx>{`
                            @keyframes slideInFromRight {
                                from {
                                    transform: translateX(100%);
                                }
                                to {
                                    transform: translateX(0);
                                }
                            }
                        `}</style>

                        <div className="modal__header">
                            <div>
                                <p className="eyebrow eyebrow--muted">Lead Details</p>
                                <h2 className="modal__title">{selectedLead.domain}</h2>
                            </div>
                            <button
                                onClick={() => setSelectedLead(null)}
                                style={{
                                    background: 'transparent',
                                    border: 'none',
                                    cursor: 'pointer',
                                    color: 'rgba(255, 255, 255, 0.6)',
                                    fontSize: '1.5rem',
                                    padding: '0.25rem',
                                    lineHeight: 1
                                }}
                            >
                                ✕
                            </button>
                        </div>

                        <div className="modal__body">
                            <label className="settings-field">
                                <span className="settings-field__label">Founder</span>
                                <div style={{ padding: '0.625rem 0', color: 'rgba(255, 255, 255, 0.9)' }}>
                                    {selectedLead.founderName || '—'}
                                </div>
                            </label>

                            <label className="settings-field">
                                <span className="settings-field__label">Email</span>
                                <div style={{ padding: '0.625rem 0', color: 'rgba(255, 255, 255, 0.9)', wordBreak: 'break-all' }}>
                                    {selectedLead.email || '—'}
                                </div>
                            </label>

                            <label className="settings-field">
                                <span className="settings-field__label">Email Status</span>
                                <div style={{
                                    padding: '0.625rem 0',
                                    color: selectedLead.verified ? '#16a34a' : 'rgba(255, 255, 255, 0.7)'
                                }}>
                                    {selectedLead.status || '—'}
                                </div>
                            </label>

                            {(selectedLead.firstLine || selectedLead.personalizationTitle) && (
                                <>
                                    <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)', margin: '1.5rem 0' }} />

                                    {selectedLead.personalizationTitle && (
                                        <label className="settings-field">
                                            <span className="settings-field__label">Product Title</span>
                                            <div style={{ padding: '0.625rem 0', color: 'rgba(255, 255, 255, 0.9)' }}>
                                                {selectedLead.personalizationTitle}
                                            </div>
                                        </label>
                                    )}

                                    {selectedLead.personalizationUrl && (
                                        <label className="settings-field">
                                            <span className="settings-field__label">Product URL</span>
                                            <a
                                                href={selectedLead.personalizationUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                style={{
                                                    display: 'block',
                                                    padding: '0.625rem 0',
                                                    color: '#3b82f6',
                                                    textDecoration: 'none',
                                                    wordBreak: 'break-all'
                                                }}
                                            >
                                                {selectedLead.personalizationUrl}
                                            </a>
                                        </label>
                                    )}

                                    {selectedLead.firstLine && (
                                        <label className="settings-field">
                                            <span className="settings-field__label">AI First Line</span>
                                            <div style={{
                                                padding: '0.75rem',
                                                backgroundColor: 'rgba(59, 130, 246, 0.1)',
                                                borderRadius: '6px',
                                                borderLeft: '3px solid rgba(59, 130, 246, 0.5)',
                                                fontStyle: 'italic',
                                                color: 'rgba(255, 255, 255, 0.9)',
                                                marginTop: '0.5rem'
                                            }}>
                                                "{selectedLead.firstLine}"
                                            </div>
                                        </label>
                                    )}
                                </>
                            )}

                            <div style={{ borderTop: '1px solid rgba(255, 255, 255, 0.1)', margin: '1.5rem 0' }} />

                            <label className="settings-field">
                                <span className="settings-field__label">Domain ID</span>
                                <div style={{
                                    padding: '0.625rem 0',
                                    color: 'rgba(255, 255, 255, 0.6)',
                                    fontFamily: 'monospace',
                                    fontSize: '0.875rem'
                                }}>
                                    {selectedLead.id}
                                </div>
                            </label>

                            {selectedLead.updatedAt && (
                                <label className="settings-field">
                                    <span className="settings-field__label">Last Updated</span>
                                    <div style={{ padding: '0.625rem 0', color: 'rgba(255, 255, 255, 0.6)', fontSize: '0.875rem' }}>
                                        {selectedLead.updatedAt}
                                    </div>
                                </label>
                            )}
                        </div>
                    </div>
                </>
            )}
        </>
    );
}
