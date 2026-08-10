"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { getPipelineBaseUrl } from "@/lib/pipeline/client";
import {
    normalizeReplyEditorHtml,
    prepareReplyEditorContent,
} from "@/lib/interested-autoresponder/replyEditorHtml";

type ReviewDraft = {
    id: number;
    leadEmail: string;
    campaignName: string;
    previousLeadMessage: string | null;
    renderedText: string;
    expiresAt: string | null;
    status?: "pending_review" | "researching" | string;
};

/** Review-page preview: Vulcan public audit → admin edit; Essence links unchanged. */
function extractReviewPreviewUrl(renderedText: string): string | null {
    const essence = renderedText.match(
        /https:\/\/essence-ai\.app\/(?:shopping-preview|preview-popup|preview)\?[^\s"'<>]+/i
    )?.[0];
    if (essence) return essence;

    const vulcan = renderedText.match(
        /https:\/\/(vulcan-shopping-audit(?:-[a-z0-9-]+)?\.vercel\.app)\/\?domain=([^\s"'<>&]+)/i
    );
    if (vulcan) {
        const host = vulcan[1];
        const domain = decodeURIComponent(vulcan[2]);
        return `https://${host}/admin/edit?domain=${encodeURIComponent(domain)}`;
    }

    return null;
}

export default function InterestedAutoResponderReviewPage() {
    const params = useParams();
    const token = String(params?.token || "");
    const [draft, setDraft] = useState<ReviewDraft | null>(null);
    const [renderedText, setRenderedText] = useState("");
    const [loading, setLoading] = useState(true);
    const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
    const [sending, setSending] = useState(false);
    const [regenerating, setRegenerating] = useState(false);
    const [archiving, setArchiving] = useState(false);
    const [archived, setArchived] = useState(false);
    const [archiveModalOpen, setArchiveModalOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sendSuccess, setSendSuccess] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);

    const editorRef = useRef<HTMLDivElement>(null);
    const lastSavedTextRef = useRef<string>("");
    const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    type LinkPopup = {
        url: string;
        anchor: HTMLAnchorElement | null;
        top: number;
        left: number;
        savedRange: Range | null;
    };
    const [linkPopup, setLinkPopup] = useState<LinkPopup | null>(null);
    const linkInputRef = useRef<HTMLInputElement>(null);
    const linkPopupRef = useRef<HTMLDivElement>(null);

    const applyLoadedDraft = useCallback((loaded: ReviewDraft | null) => {
        if (!loaded) {
            setDraft(null);
            return;
        }
        const initialText = loaded.renderedText || "";
        const preparedText = prepareReplyEditorContent(initialText);
        lastSavedTextRef.current = preparedText;
        setDraft(loaded);
        setRenderedText(preparedText);
        setPreviewUrl(extractReviewPreviewUrl(initialText));
        if (editorRef.current) {
            editorRef.current.innerHTML = preparedText;
        }
        setRegenerating(loaded.status === "researching");
    }, []);

    useEffect(() => {
        if (!token) return;
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                const draftResponse = await fetch(`${getPipelineBaseUrl()}/api/interested-autoresponder/review/${encodeURIComponent(token)}`, {
                    cache: "no-store"
                });
                const data = await draftResponse.json().catch(() => ({}));
                if (!draftResponse.ok) {
                    throw new Error(data.error || `Failed to load review draft (${draftResponse.status})`);
                }
                if (!cancelled) {
                    applyLoadedDraft(data.draft || null);
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
    }, [token, applyLoadedDraft]);

    // Poll while a regenerate research run is in flight (same review token).
    useEffect(() => {
        if (!token || !regenerating || sendSuccess || archived) return;
        let cancelled = false;
        const poll = async () => {
            try {
                const response = await fetch(
                    `${getPipelineBaseUrl()}/api/interested-autoresponder/review/${encodeURIComponent(token)}`,
                    { cache: "no-store" }
                );
                const data = await response.json().catch(() => ({}));
                if (cancelled) return;
                if (!response.ok) {
                    setRegenerating(false);
                    setError(data.error || `Regeneration failed (${response.status})`);
                    return;
                }
                const next = data.draft as ReviewDraft | undefined;
                if (!next) return;
                if (next.status === "researching") return;
                applyLoadedDraft(next);
                setError(null);
            } catch (err) {
                if (!cancelled) {
                    setRegenerating(false);
                    setError(err instanceof Error ? err.message : "Failed while waiting for regeneration");
                }
            }
        };
        const intervalId = setInterval(poll, 3000);
        const timeoutId = setTimeout(() => {
            if (cancelled) return;
            setRegenerating(false);
            setError("Regeneration is taking longer than expected. Refresh this page in a minute.");
        }, 5 * 60 * 1000);
        return () => {
            cancelled = true;
            clearInterval(intervalId);
            clearTimeout(timeoutId);
        };
    }, [token, regenerating, sendSuccess, archived, applyLoadedDraft]);

    // Sync editor innerHTML when draft first loads
    useEffect(() => {
        if (editorRef.current && draft && !regenerating) {
            editorRef.current.innerHTML = prepareReplyEditorContent(draft.renderedText || "");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft?.id]);

    // Prefer <p> over <div> for new paragraphs so formatting stays consistent
    useEffect(() => {
        try {
            document.execCommand("defaultParagraphSeparator", false, "p");
        } catch {
            // execCommand may be unavailable in some environments
        }
    }, []);

    // Debounced auto-save
    useEffect(() => {
        if (archived || regenerating || !draft) return;
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
    }, [renderedText, token, archived, regenerating, draft]);

    // Close archive modal on Escape
    useEffect(() => {
        if (!archiveModalOpen) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !archiving) setArchiveModalOpen(false);
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [archiveModalOpen, archiving]);

    const syncEditorContent = useCallback((syncDom = false) => {
        if (!editorRef.current) return;
        const normalized = normalizeReplyEditorHtml(editorRef.current.innerHTML);
        if (syncDom && normalized !== editorRef.current.innerHTML) {
            editorRef.current.innerHTML = normalized;
        }
        setRenderedText(normalized);
    }, []);

    const handleEditorInput = useCallback(() => {
        syncEditorContent(false);
    }, [syncEditorContent]);

    const handleEditorBlur = useCallback(() => {
        syncEditorContent(true);
    }, [syncEditorContent]);

    const handleEditorPaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain");
        if (!text) return;
        document.execCommand("insertText", false, text);
        syncEditorContent(false);
    }, [syncEditorContent]);

    const openLinkPopup = useCallback(() => {
        const sel = window.getSelection();
        if (!sel) return;

        // Find the anchor the cursor is inside (if any)
        let anchor: HTMLAnchorElement | null = null;
        const node = sel.anchorNode;
        let el: Node | null = node instanceof Element ? node : node?.parentElement ?? null;
        while (el && el !== editorRef.current) {
            if (el instanceof HTMLAnchorElement) { anchor = el; break; }
            el = el.parentElement;
        }

        // Save the current selection range so we can restore it before execCommand
        const savedRange = sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;

        // Position the popover near the selection or anchor
        let rect: DOMRect | null = null;
        if (anchor) {
            rect = anchor.getBoundingClientRect();
        } else if (sel.rangeCount > 0) {
            rect = sel.getRangeAt(0).getBoundingClientRect();
        }
        const top = rect ? rect.bottom + window.scrollY + 8 : 200;
        const left = rect ? Math.max(8, rect.left + window.scrollX) : 80;

        setLinkPopup({
            url: anchor?.href ?? "",
            anchor,
            top,
            left,
            savedRange,
        });
        // Focus the input on next tick
        setTimeout(() => linkInputRef.current?.focus(), 0);
    }, []);

    const applyLink = useCallback((url: string) => {
        if (!editorRef.current) return;
        editorRef.current.focus();
        const sel = window.getSelection();

        if (linkPopup?.anchor) {
            // Edit existing link
            if (url) {
                linkPopup.anchor.href = url;
            } else {
                // Remove link but keep text
                const parent = linkPopup.anchor.parentNode;
                if (parent) {
                    while (linkPopup.anchor.firstChild) {
                        parent.insertBefore(linkPopup.anchor.firstChild, linkPopup.anchor);
                    }
                    parent.removeChild(linkPopup.anchor);
                }
            }
        } else if (linkPopup?.savedRange && sel) {
            // Restore saved selection before execCommand
            sel.removeAllRanges();
            sel.addRange(linkPopup.savedRange);
            if (url) {
                document.execCommand("createLink", false, url);
                // Style newly created links (execCommand doesn't apply class)
            } else {
                document.execCommand("unlink", false, undefined);
            }
        }

        setLinkPopup(null);
        syncEditorContent(true);
    }, [linkPopup, syncEditorContent]);

    const handleEditorKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
            e.preventDefault();
            openLinkPopup();
        }
    }, [openLinkPopup]);

    // Close popup on outside click
    useEffect(() => {
        if (!linkPopup) return;
        const handler = (e: MouseEvent) => {
            if (linkPopupRef.current && !linkPopupRef.current.contains(e.target as Node)) {
                setLinkPopup(null);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [linkPopup]);

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

    const handleRegenerate = async () => {
        setError(null);
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        setRegenerating(true);
        try {
            const response = await fetch(
                `${getPipelineBaseUrl()}/api/interested-autoresponder/review/${encodeURIComponent(token)}/regenerate`,
                { method: "POST" }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `Failed to regenerate (${response.status})`);
            }
            if (data.regenerating) {
                // Async research workflow — keep polling until pending_review.
                setRegenerating(true);
                return;
            }
            if (data.draft) {
                applyLoadedDraft(data.draft);
            } else {
                setRegenerating(false);
            }
        } catch (err) {
            setRegenerating(false);
            setError(err instanceof Error ? err.message : "Failed to regenerate draft");
        }
    };

    const handleArchiveDraft = async () => {
        setArchiving(true);
        setError(null);
        try {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
            const response = await fetch(
                `${getPipelineBaseUrl()}/api/interested-autoresponder/review/${encodeURIComponent(token)}`,
                { method: "DELETE" }
            );
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || `Failed to archive draft (${response.status})`);
            }
            setArchived(true);
            setArchiveModalOpen(false);
            setDraft(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to archive draft");
        } finally {
            setArchiving(false);
        }
    };

    return (
        <main style={{ minHeight: "100vh", background: "#0b1020", color: "#fff", padding: "1rem 0.25rem" }}>
            <style>{`
                .reply-editor {
                    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                }
                .reply-editor,
                .reply-editor * {
                    font-family: inherit !important;
                    font-size: inherit !important;
                    line-height: inherit !important;
                }
                .reply-editor a { color: #60a5fa !important; text-decoration: underline !important; }
                .reply-editor p,
                .reply-editor div { margin: 0 0 0.8em; }
                .reply-editor p:last-child,
                .reply-editor div:last-child { margin-bottom: 0; }
                .reply-editor br { display: block; }
                .reply-editor:focus { box-shadow: 0 0 0 2px rgba(96,165,250,0.3); }
                .ar-card { padding: 1rem; }
                @media (min-width: 640px) {
                    .ar-card { padding: 1.5rem; }
                    main { padding: 2rem 1rem; }
                }
                .link-popup {
                    position: absolute;
                    z-index: 9999;
                    background: #1e2538;
                    border: 1px solid rgba(255,255,255,0.15);
                    border-radius: 10px;
                    padding: 0.6rem 0.75rem;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                    min-width: 320px;
                }
                .link-popup input {
                    flex: 1;
                    background: rgba(0,0,0,0.3);
                    border: 1px solid rgba(255,255,255,0.12);
                    border-radius: 6px;
                    padding: 0.35rem 0.6rem;
                    color: #fff;
                    font-size: 0.85rem;
                    outline: none;
                }
                .link-popup input:focus {
                    border-color: rgba(96,165,250,0.6);
                    box-shadow: 0 0 0 2px rgba(96,165,250,0.2);
                }
                .link-popup button {
                    flex-shrink: 0;
                    padding: 0.32rem 0.65rem;
                    border-radius: 6px;
                    border: none;
                    font-size: 0.82rem;
                    font-weight: 600;
                    cursor: pointer;
                }
                .link-popup .btn-apply { background: #2563eb; color: #fff; }
                .link-popup .btn-apply:hover { background: #1d4ed8; }
                .link-popup .btn-remove { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
                .link-popup .btn-remove:hover { background: rgba(239,68,68,0.25); }
                .ar-modal-overlay {
                    position: fixed;
                    inset: 0;
                    z-index: 10000;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 1rem;
                    background: rgba(0,0,0,0.65);
                }
                .ar-modal {
                    width: 100%;
                    max-width: 420px;
                    padding: 1.25rem;
                    border-radius: 16px;
                    background: #151b2e;
                    border: 1px solid rgba(255,255,255,0.12);
                    box-shadow: 0 24px 64px rgba(0,0,0,0.45);
                }
                .ar-modal__title {
                    margin: 0 0 0.5rem;
                    font-size: 1.1rem;
                    font-weight: 600;
                }
                .ar-modal__body {
                    margin: 0 0 1.25rem;
                    color: rgba(255,255,255,0.72);
                    font-size: 0.9rem;
                    line-height: 1.55;
                }
                .ar-modal__actions {
                    display: flex;
                    justify-content: flex-end;
                    gap: 0.65rem;
                }
                .ar-btn-secondary {
                    padding: 0.65rem 1rem;
                    border-radius: 8px;
                    border: 1px solid rgba(255,255,255,0.15);
                    background: rgba(255,255,255,0.04);
                    color: #fff;
                    font-weight: 600;
                    font-size: 0.9rem;
                    cursor: pointer;
                }
                .ar-btn-secondary:hover:not(:disabled) { background: rgba(255,255,255,0.08); }
                .ar-btn-destructive {
                    padding: 0.65rem 1rem;
                    border-radius: 8px;
                    border: 1px solid rgba(239,68,68,0.45);
                    background: rgba(239,68,68,0.18);
                    color: #fca5a5;
                    font-weight: 600;
                    font-size: 0.9rem;
                    cursor: pointer;
                }
                .ar-btn-destructive:hover:not(:disabled) { background: rgba(239,68,68,0.28); }
                .ar-btn-secondary:disabled, .ar-btn-destructive:disabled { opacity: 0.55; cursor: default; }
            `}</style>
            {archiveModalOpen && (
                <div
                    className="ar-modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="archive-draft-title"
                    onClick={() => { if (!archiving) setArchiveModalOpen(false); }}
                >
                    <div className="ar-modal" onClick={(e) => e.stopPropagation()}>
                        <h2 id="archive-draft-title" className="ar-modal__title">Archive Draft?</h2>
                        <p className="ar-modal__body">
                            This will cancel the draft and invalidate this review link. You will not be able to send this reply from here.
                        </p>
                        <div className="ar-modal__actions">
                            <button
                                type="button"
                                className="ar-btn-secondary"
                                onClick={() => setArchiveModalOpen(false)}
                                disabled={archiving}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="ar-btn-destructive"
                                onClick={handleArchiveDraft}
                                disabled={archiving}
                            >
                                {archiving ? "Archiving…" : "Archive Draft"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {linkPopup && (
                <div
                    ref={linkPopupRef}
                    className="link-popup"
                    style={{ top: linkPopup.top, left: linkPopup.left }}
                >
                    <span style={{ fontSize: "0.75rem", color: "rgba(255,255,255,0.45)", flexShrink: 0 }}>🔗</span>
                    <input
                        ref={linkInputRef}
                        type="url"
                        placeholder="https://"
                        value={linkPopup.url}
                        onChange={(e) => setLinkPopup(p => p ? { ...p, url: e.target.value } : p)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); applyLink(linkPopup.url); }
                            if (e.key === "Escape") { e.preventDefault(); setLinkPopup(null); }
                        }}
                    />
                    <button type="button" className="btn-apply" onClick={() => applyLink(linkPopup.url)}>Apply</button>
                    {linkPopup.anchor && (
                        <button type="button" className="btn-remove" onClick={() => applyLink("")}>Remove</button>
                    )}
                </div>
            )}
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
                ) : archived ? (
                    <div style={{ marginTop: "1.5rem", padding: "1rem", borderRadius: "12px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.82)" }}>
                        This draft has been archived and is no longer available.
                    </div>
                ) : draft ? (
                    <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
                        <div style={{ display: "grid", gap: "0.35rem", fontSize: "0.9rem" }}>
                            <div><strong>Lead:</strong> {draft.leadEmail}</div>
                            <div><strong>Campaign:</strong> {draft.campaignName}</div>
                            <div><strong>Preview Link:</strong> <a style={{ color: "rgb(29, 132, 235)", textDecoration: "underline" }} href={previewUrl??""} target="_blank" rel="noopener noreferrer">{previewUrl}</a></div>
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
                                contentEditable={!sendSuccess && !regenerating}
                                suppressContentEditableWarning
                                onInput={handleEditorInput}
                                onBlur={handleEditorBlur}
                                onPaste={handleEditorPaste}
                                onKeyDown={handleEditorKeyDown}
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
                                    cursor: sendSuccess || regenerating ? "default" : "text",
                                    wordBreak: "break-word",
                                    transition: "box-shadow 0.15s",
                                    opacity: sendSuccess || regenerating ? 0.7 : 1,
                                }}
                            />
                            <p style={{ margin: 0, fontSize: "0.75rem", color: "rgba(255,255,255,0.35)" }}>
                                {regenerating
                                    ? "Regenerating research, popup, and reply… this can take a minute."
                                    : <>Click to edit — changes are saved automatically. Press <kbd style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: "4px", padding: "0 4px", fontSize: "0.72rem" }}>⌘K</kbd> to edit a link.</>}
                            </p>
                            <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
                                {!sendSuccess && (
                                    <button
                                        type="button"
                                        onClick={handleRegenerate}
                                        disabled={sending || regenerating || archiving}
                                        style={{
                                            width: "100%",
                                            padding: "0.85rem",
                                            borderRadius: "10px",
                                            border: "1px solid rgba(96,165,250,0.45)",
                                            background: regenerating ? "rgba(37,99,235,0.25)" : "rgba(37,99,235,0.14)",
                                            color: "#93c5fd",
                                            cursor: sending || regenerating || archiving ? "default" : "pointer",
                                            fontWeight: 600,
                                            fontSize: "0.95rem",
                                            opacity: sending || regenerating || archiving ? 0.7 : 1,
                                        }}
                                    >
                                        {regenerating ? "Regenerating…" : "Regenerate"}
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={handleSendReply}
                                    disabled={sending || regenerating || !renderedText.trim() || sendSuccess}
                                    style={{ width: "100%", padding: "0.9rem", borderRadius: "10px", border: "none", background: sendSuccess ? "rgba(34,197,94,0.25)" : "#16a34a", color: "#fff", cursor: sending || regenerating || sendSuccess ? "default" : "pointer", fontWeight: 600, fontSize: "1rem", opacity: regenerating ? 0.55 : 1 }}
                                >
                                    {sending ? "Sending…" : sendSuccess ? "Sent ✓" : "Send Reply"}
                                </button>
                                {!sendSuccess && (
                                    <button
                                        type="button"
                                        onClick={() => setArchiveModalOpen(true)}
                                        disabled={sending || regenerating || archiving}
                                        style={{
                                            width: "100%",
                                            padding: "0.75rem",
                                            borderRadius: "10px",
                                            border: "1px solid rgba(239,68,68,0.45)",
                                            background: "rgba(239,68,68,0.12)",
                                            color: "#fca5a5",
                                            cursor: sending || regenerating || archiving ? "default" : "pointer",
                                            fontWeight: 600,
                                            fontSize: "0.95rem",
                                            opacity: sending || regenerating || archiving ? 0.55 : 1,
                                        }}
                                    >
                                        Archive Draft
                                    </button>
                                )}
                            </div>
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
