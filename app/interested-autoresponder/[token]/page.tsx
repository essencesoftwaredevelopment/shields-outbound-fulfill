"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
    const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sendSuccess, setSendSuccess] = useState(false);

    const editorRef = useRef<HTMLDivElement>(null);
    const lastSavedTextRef = useRef<string>("");
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
                    const initialText = data.draft?.renderedText || "";
                    lastSavedTextRef.current = initialText;
                    setDraft(data.draft || null);
                    setRenderedText(initialText);
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
        return () => { cancelled = true; };
    }, [token]);

    // Sync editor innerHTML when draft first loads
    useEffect(() => {
        if (editorRef.current && draft) {
            editorRef.current.innerHTML = draft.renderedText || "";
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft?.id]);

    // Debounced auto-save
    useEffect(() => {
        if (renderedText === lastSavedTextRef.current) return;
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(async () => {
            setSaveStatus("saving");
            try {
                const response = await fetch(
                    `${getPipelineBaseUrl()}/api/interested-autoresponder/review/${encodeURIComponent(token)}`,
                    {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ renderedText }),
                    }
                );
                if (response.ok) {
                    const data = await response.json().catch(() => ({}));
                    const saved = data.draft?.renderedText || renderedText;
                    lastSavedTextRef.current = saved;
                    setDraft(prev => prev ? { ...prev, renderedText: saved } : prev);
                    setSaveStatus("saved");
                    setTimeout(() => setSaveStatus(s => s === "saved" ? "idle" : s), 2500);
                } else {
                    setSaveStatus("idle");
                }
            } catch {
                setSaveStatus("idle");
            }
        }, 1500);
        return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
    }, [renderedText, token]);

    const handleEditorInput = useCallback(() => {
        if (editorRef.current) setRenderedText(editorRef.current.innerHTML);
    }, []);

    const handleSendReply = async () => {
        setSending(true);
        setError(null);
        try {
            // Cancel pending debounce and flush save if dirty
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
            if (renderedText !== lastSavedTextRef.current) {
                setSaveStatus("saving");
                const updateResponse = await fetch(
                    `${getPipelineBaseUrl()}/api/interested-autoresponder/review/${encodeURIComponent(token)}`,
                    {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ renderedText }),
                    }
                );
                if (updateResponse.ok) {
                    lastSavedTextRef.current = renderedText;
                    setSaveStatus("saved");
                }
            }
            const response = await fetch(
                `${getPipelineBaseUrl()}/api/interested-autoresponder/review/${encodeURIComponent(token)}/send`,
                { method: "POST" }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `Failed to send reply (${response.status})`);
            }
            setSendSuccess(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to send reply");
        } finally {
            setSending(false);
        }
    };

    return (
        <main style={{ minHeight: "100vh", background: "#0b1020", color: "#fff", padding: "1rem 0.25rem" }}>
            <style>{`
                .reply-editor a { color: #60a5fa !important; text-decoration: underline !important; }
                .reply-editor p { margin: 0 0 0.8em; }
                .reply-editor p:last-child { margin-bottom: 0; }
                .reply-editor br { display: block; }
                .reply-editor:focus { box-shadow: 0 0 0 2px rgba(96,165,250,0.3); }
                .ar-card { padding: 1rem; }
                @media (min-width: 640px) {
                    .ar-card { padding: 1.5rem; }
                    main { padding: 2rem 1rem; }
                }
            `}</style>
            <div className="ar-card" style={{ maxWidth: "840px", margin: "0 auto", borderRadius: "20px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}>
                <p style={{ margin: 0, textTransform: "uppercase", letterSpacing: "0.08em", fontSize: "0.72rem", color: "rgba(255,255,255,0.45)" }}>
                    Interested Lead Auto-Responder
                </p>

                {loading ? (
                    <p style={{ marginTop: "1.5rem", color: "rgba(255,255,255,0.65)" }}>Loading…</p>
                ) : error ? (
                    <div style={{ marginTop: "1.5rem", padding: "1rem", borderRadius: "12px", background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.35)", color: "#fca5a5" }}>
                        {error}
                    </div>
                ) : draft ? (
                    <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
                        <div style={{ display: "grid", gap: "0.35rem", fontSize: "0.9rem" }}>
                            <div><strong>Lead:</strong> {draft.leadEmail}</div>
                            <div><strong>Campaign:</strong> {draft.campaignName}</div>
                        </div>

                        {/* Reply editor — rendered HTML, contentEditable */}
                        <section style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                                <h2 style={{ margin: 0, fontSize: "1rem" }}>Reply:</h2>
                                {saveStatus === "saving" && (
                                    <span style={{ fontSize: "0.75rem", color: "rgba(255,255,255,0.45)" }}>Saving…</span>
                                )}
                                {saveStatus === "saved" && (
                                    <span style={{ fontSize: "0.75rem", color: "#4ade80" }}>Saved</span>
                                )}
                            </div>
                            <div
                                ref={editorRef}
                                contentEditable
                                suppressContentEditableWarning
                                onInput={handleEditorInput}
                                className="reply-editor"
                                style={{
                                    minHeight: "180px",
                                    padding: "1rem",
                                    borderRadius: "12px",
                                    border: "1px solid rgba(255,255,255,0.12)",
                                    background: "rgba(0,0,0,0.24)",
                                    color: "#fff",
                                    outline: "none",
                                    lineHeight: 1.65,
                                    fontSize: "0.9rem",
                                    cursor: "text",
                                    wordBreak: "break-word",
                                    transition: "box-shadow 0.15s",
                                }}
                            />
                            <p style={{ margin: 0, fontSize: "0.75rem", color: "rgba(255,255,255,0.35)" }}>
                                Click to edit — changes are saved automatically.
                            </p>
                            <button
                                type="button"
                                onClick={handleSendReply}
                                disabled={sending || !renderedText.trim() || sendSuccess}
                                style={{ width: "100%", padding: "0.9rem", borderRadius: "10px", border: "none", background: sendSuccess ? "rgba(34,197,94,0.25)" : "#16a34a", color: "#fff", cursor: sending || sendSuccess ? "default" : "pointer", fontWeight: 600, fontSize: "1rem" }}
                            >
                                {sending ? "Sending…" : sendSuccess ? "Sent ✓" : "Send Reply"}
                            </button>
                        </section>

                        {/* Previous Lead Message — shown below the reply */}
                        <section style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                            <h2 style={{ margin: 0, fontSize: "1rem" }}>Previous Lead Message</h2>
                            <div style={{ whiteSpace: "pre-wrap", padding: "1rem", borderRadius: "12px", background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.82)", fontSize: "0.9rem", lineHeight: 1.65 }}>
                                {draft.previousLeadMessage || "No prior lead message available."}
                            </div>
                        </section>

                        {sendSuccess && (
                            <div style={{ padding: "0.9rem 1rem", borderRadius: "12px", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.35)", color: "#86efac" }}>
                                Reply sent successfully.
                            </div>
                        )}
                        {error && (
                            <div style={{ padding: "0.9rem 1rem", borderRadius: "12px", background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.35)", color: "#fca5a5" }}>
                                {error}
                            </div>
                        )}


                    </div>
                ) : (
                    <p style={{ marginTop: "1.5rem", color: "rgba(255,255,255,0.65)" }}>Draft not found.</p>
                )}
            </div>
        </main>
    );
}
