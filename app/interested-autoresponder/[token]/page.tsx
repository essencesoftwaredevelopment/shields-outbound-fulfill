"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { getPipelineBaseUrl } from "@/lib/pipeline/client";

type ReviewDraft = {
    id: number;
    leadEmail: string;
    campaignName: string;
    previousLeadMessage: string | null;
    renderedText: string;
    expiresAt: string | null;
};

export default function InterestedAutoResponderReviewPage() {
    const params = useParams();
    const token = String(params?.token || "");
    const [draft, setDraft] = useState<ReviewDraft | null>(null);
    const [renderedText, setRenderedText] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);

    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const response = await fetch(`${getPipelineBaseUrl()}/api/interested-autoresponder/review/${encodeURIComponent(token)}`, {
                    cache: "no-store"
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.error || `Failed to load review draft (${response.status})`);
                }
                if (!cancelled) {
                    setDraft(data.draft || null);
                    setRenderedText(data.draft?.renderedText || "");
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : "Failed to load review draft");
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [token]);

    const handleSaveEdit = async () => {
        setSaving(true);
        setError(null);
        setSuccessMessage(null);
        try {
            const response = await fetch(`${getPipelineBaseUrl()}/api/interested-autoresponder/review/${encodeURIComponent(token)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ renderedText })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `Failed to update draft (${response.status})`);
            }
            setDraft((prev) => prev ? { ...prev, renderedText: data.draft?.renderedText || renderedText } : prev);
            setRenderedText(data.draft?.renderedText || renderedText);
            setSuccessMessage("Reply updated.");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to update draft");
        } finally {
            setSaving(false);
        }
    };

    const handleSendReply = async () => {
        setSending(true);
        setError(null);
        setSuccessMessage(null);
        try {
            if (draft && renderedText.trim() && renderedText !== draft.renderedText) {
                const updateResponse = await fetch(`${getPipelineBaseUrl()}/api/interested-autoresponder/review/${encodeURIComponent(token)}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ renderedText })
                });
                const updateData = await updateResponse.json().catch(() => ({}));
                if (!updateResponse.ok) {
                    throw new Error(updateData.error || `Failed to update draft (${updateResponse.status})`);
                }
                setDraft((prev) => prev ? { ...prev, renderedText: updateData.draft?.renderedText || renderedText } : prev);
            }
            const response = await fetch(`${getPipelineBaseUrl()}/api/interested-autoresponder/review/${encodeURIComponent(token)}/send`, {
                method: "POST"
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `Failed to send reply (${response.status})`);
            }
            setSuccessMessage("Reply sent.");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to send reply");
        } finally {
            setSending(false);
        }
    };

    return (
        <main style={{ minHeight: "100vh", background: "#0b1020", color: "#fff", padding: "2rem 1rem" }}>
            <div style={{ maxWidth: "840px", margin: "0 auto", padding: "1.5rem", borderRadius: "20px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}>
                <p style={{ margin: 0, textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.72rem", color: "rgba(255,255,255,0.45)" }}>
                    Interested Lead Auto-Responder
                </p>
                <h1 style={{ margin: "0.5rem 0 0", fontSize: "1.8rem" }}>Review Reply Draft</h1>

                {loading ? (
                    <p style={{ marginTop: "1.5rem", color: "rgba(255,255,255,0.65)" }}>Loading…</p>
                ) : error ? (
                    <div style={{ marginTop: "1.5rem", padding: "1rem", borderRadius: "12px", background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.35)", color: "#fca5a5" }}>
                        {error}
                    </div>
                ) : draft ? (
                    <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
                        <div style={{ display: "grid", gap: "0.35rem" }}>
                            <div><strong>Lead:</strong> {draft.leadEmail}</div>
                            <div><strong>Campaign:</strong> {draft.campaignName}</div>
                            {draft.expiresAt && <div><strong>Expires:</strong> {new Date(draft.expiresAt).toLocaleString()}</div>}
                        </div>

                        <section style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                            <h2 style={{ margin: 0, fontSize: "1rem" }}>Previous Lead Message</h2>
                            <div style={{ whiteSpace: "pre-wrap", padding: "1rem", borderRadius: "12px", background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.82)" }}>
                                {draft.previousLeadMessage || "No prior lead message available."}
                            </div>
                        </section>

                        <section style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                            <h2 style={{ margin: 0, fontSize: "1rem" }}>AI-Generated Follow-Up</h2>
                            <textarea
                                value={renderedText}
                                onChange={(event) => setRenderedText(event.target.value)}
                                rows={14}
                                style={{
                                    width: "100%",
                                    padding: "1rem",
                                    borderRadius: "12px",
                                    border: "1px solid rgba(255,255,255,0.12)",
                                    background: "rgba(0,0,0,0.24)",
                                    color: "#fff",
                                    resize: "vertical",
                                    fontFamily: "var(--font-geist-mono), monospace"
                                }}
                            />
                        </section>

                        {successMessage && (
                            <div style={{ padding: "0.9rem 1rem", borderRadius: "12px", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.35)", color: "#86efac" }}>
                                {successMessage}
                            </div>
                        )}

                        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
                            <button
                                type="button"
                                onClick={handleSaveEdit}
                                disabled={saving || sending || !renderedText.trim()}
                                style={{ padding: "0.8rem 1.1rem", borderRadius: "10px", border: "none", background: "#1d4ed8", color: "#fff", cursor: "pointer" }}
                            >
                                {saving ? "Saving..." : "Edit Reply"}
                            </button>
                            <button
                                type="button"
                                onClick={handleSendReply}
                                disabled={saving || sending || !renderedText.trim() || successMessage === "Reply sent."}
                                style={{ padding: "0.8rem 1.1rem", borderRadius: "10px", border: "none", background: "#16a34a", color: "#fff", cursor: "pointer" }}
                            >
                                {sending ? "Sending..." : "Send Reply"}
                            </button>
                        </div>
                    </div>
                ) : (
                    <p style={{ marginTop: "1.5rem", color: "rgba(255,255,255,0.65)" }}>Draft not found.</p>
                )}
            </div>
        </main>
    );
}
