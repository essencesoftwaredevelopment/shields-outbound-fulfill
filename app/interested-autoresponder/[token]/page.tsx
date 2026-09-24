"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { ChevronDown, ChevronUp, ExternalLink, Globe, Link2, Phone } from "lucide-react";
import { getPipelineBaseUrl } from "@/lib/pipeline/client";
import { InterestedResearchProgress } from "@/components/interested-research-progress";
import {
    normalizeReplyEditorHtml,
    prepareReplyEditorContent,
} from "@/lib/interested-autoresponder/replyEditorHtml";

type ResearchBriefSource = { title?: string | null; url?: string | null };

/** Mirrors normalizeResearchBrief on the server; every field is optional for legacy rows. */
type ResearchBrief = {
    company?: string | null;
    domain?: string | null;
    industry?: string | null;
    summary?: string | null;
    talkingPoints?: string[] | null;
    risks?: string[] | null;
    sources?: ResearchBriefSource[] | null;
    reviewCount?: number | null;
    estimatedVisitors?: number | null;
};

/** One email in the lead's thread (server/src/utils/threadMessages.js). */
type ThreadMessage = {
    id: number | string;
    direction: "inbound" | "outbound";
    kind: string;
    from: string | null;
    subject: string | null;
    text: string;
    sentAt: string | null;
};

type ReviewDraft = {
    id: number;
    leadEmail: string;
    campaignName: string;
    previousLeadMessage: string | null;
    renderedText: string;
    expiresAt: string | null;
    status?: "pending_review" | "researching" | string;
    researchStep?: string | null;
    websiteDomain?: string | null;
    websiteUrl?: string | null;
    researchBrief?: ResearchBrief | null;
    researchCompletedAt?: string | null;
    thread?: ThreadMessage[] | null;
    /** Founder phone from the Enrow lookup; null when never looked up. */
    phone?: {
        number: string | null;
        country: string | null;
        telUri: string | null;
        status: "found" | "not_found" | "pending" | "timeout" | "error" | string;
    } | null;
};

/** Pill label for a phone lookup that has no number (null = show nothing). */
function phoneStatusLabel(status: string | undefined): string | null {
    if (status === "pending" || status === "timeout") return "Phone lookup running";
    if (status === "not_found") return "No phone found";
    return null;
}

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

function domainFromLeadEmail(leadEmail: string): string | null {
    const atIndex = String(leadEmail || "").indexOf("@");
    if (atIndex === -1) return null;
    const host = String(leadEmail)
        .slice(atIndex + 1)
        .trim()
        .toLowerCase()
        .replace(/^www\./, "")
        .split("/")[0]
        .split("?")[0]
        .split("#")[0]
        .split(":")[0];
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) return null;
    return host;
}

function websiteFromDraft(draft: ReviewDraft): { href: string; domain: string } | null {
    const domain = draft.websiteDomain || domainFromLeadEmail(draft.leadEmail);
    const href = draft.websiteUrl || (domain ? `https://${domain}` : null);
    if (!href || !domain) return null;
    return { href, domain };
}

/** Display labels for the research industry enum (server/.../briefUtils.js RESEARCH_INDUSTRIES). */
const INDUSTRY_LABELS: Record<string, string> = {
    beauty_skincare: "Beauty & skincare",
    fashion_apparel: "Fashion & apparel",
    food_beverage: "Food & beverage",
    health_wellness: "Health & wellness",
    home_garden: "Home & garden",
    electronics: "Electronics",
    automotive: "Automotive",
    pets: "Pets",
    sports_outdoors: "Sports & outdoors",
    jewelry_accessories: "Jewelry & accessories",
    kids_baby: "Kids & baby",
    gifts_collectibles: "Gifts & collectibles",
};

function industryLabel(value: string | null | undefined): string | null {
    const key = String(value || "").trim();
    if (!key) return null;
    if (INDUSTRY_LABELS[key]) return INDUSTRY_LABELS[key];
    const words = key.replace(/_/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
}

function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

function stringList(value: unknown): string[] {
    return (Array.isArray(value) ? value : [])
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean);
}

function positiveInt(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function formatShortDate(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function formatMessageDate(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const THREAD_KIND_LABELS: Record<string, string> = {
    auto_reply: "Auto-reply",
    autoresponder: "Auto-responder",
    manual: "Manual reply",
    follow_up: "Follow-up",
    campaign: "Campaign email",
};

type ThreadViewProps = { messages: ThreadMessage[] };

function messagePreview(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

function ThreadView({ messages }: ThreadViewProps) {
    // Newest first; every message starts collapsed and opens on click.
    const ordered = [...messages].sort((a, b) => String(b.sentAt || "").localeCompare(String(a.sentAt || "")));
    const subject = ordered.find((message) => message.subject)?.subject ?? null;
    const [expanded, setExpanded] = useState<Set<ThreadMessage["id"]>>(() => new Set());

    const toggle = (id: ThreadMessage["id"]) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    return (
        <div className="ar-thread">
            {subject && <p className="ar-thread__subject" title={subject}>{subject}</p>}
            {ordered.map((message) => {
                const inbound = message.direction === "inbound";
                const kind = THREAD_KIND_LABELS[message.kind];
                const when = formatMessageDate(message.sentAt);
                const open = expanded.has(message.id);
                const bodyId = `ar-thread-body-${String(message.id)}`;
                return (
                    <article
                        key={message.id}
                        className={`ar-thread__msg ar-thread__msg--${message.direction}${open ? " ar-thread__msg--open" : ""}`}
                    >
                        <button
                            type="button"
                            className="ar-thread__head"
                            onClick={() => toggle(message.id)}
                            aria-expanded={open}
                            aria-controls={bodyId}
                        >
                            <span className="ar-thread__meta">
                                <span className={`ar-thread__who${inbound ? " ar-thread__who--inbound" : ""}`}>
                                    {inbound ? "Lead" : "You"}
                                </span>
                                {message.from && <span className="ar-thread__from" title={message.from}>{message.from}</span>}
                                {kind && <span className="ar-thread__kind">· {kind}</span>}
                                {when && <span className="ar-thread__date">{when}</span>}
                                <span className="ar-thread__chevron" aria-hidden="true">
                                    {open ? <ChevronUp size={14} strokeWidth={2} /> : <ChevronDown size={14} strokeWidth={2} />}
                                </span>
                            </span>
                            {!open && <span className="ar-thread__preview">{messagePreview(message.text)}</span>}
                        </button>
                        {open && (
                            <p id={bodyId} className="ar-thread__body">{message.text}</p>
                        )}
                    </article>
                );
            })}
        </div>
    );
}

type ResearchPanelProps = {
    brief: ResearchBrief | null | undefined;
    completedAt: string | null | undefined;
    researching: boolean;
};

function ResearchPanel({ brief, completedAt, researching }: ResearchPanelProps) {
    const summary = String(brief?.summary || "").trim();
    const talkingPoints = stringList(brief?.talkingPoints);
    const risks = stringList(brief?.risks);
    const rawSources = brief?.sources;
    const sources = (Array.isArray(rawSources) ? rawSources : [])
        .map((source) => ({ title: String(source?.title || "").trim(), url: String(source?.url || "").trim() }))
        .filter((source) => source.url);
    const reviewCount = positiveInt(brief?.reviewCount);
    const estimatedVisitors = positiveInt(brief?.estimatedVisitors);
    const industry = industryLabel(brief?.industry);
    const company = String(brief?.company || "").trim();
    const domain = String(brief?.domain || "").trim();
    const researchedOn = formatShortDate(completedAt);

    return (
        <div className="ar-panel ar-research" aria-label="Prospect research">
            <div className="ar-panel__head">
                <p className="eyebrow eyebrow--muted">Research</p>
                {!researching && researchedOn && (
                    <span className="ar-save-state">{researchedOn}</span>
                )}
            </div>

            {researching ? (
                <p className="ar-research__empty">
                    Research is running. The brief will appear here as soon as the draft is ready.
                </p>
            ) : !summary ? (
                <p className="ar-research__empty">
                    No research brief for this lead — the reply was drafted from the thread alone.
                </p>
            ) : (
                <>
                    {(company || domain || industry) && (
                        <div className="ar-research__company">
                            {company && <h2 className="ar-research__name">{company}</h2>}
                            {domain && (
                                <a
                                    className="ar-research__domain"
                                    href={`https://${domain}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    <Globe size={13} strokeWidth={2} />
                                    {domain}
                                </a>
                            )}
                            {industry && (
                                <span className="lead-pastel-chip lead-pastel-chip--list ar-research__industry">
                                    {industry}
                                </span>
                            )}
                        </div>
                    )}

                    <p className="ar-research__summary">{summary}</p>

                    {talkingPoints.length > 0 && (
                        <section className="ar-research__section">
                            <p className="ar-research__label">Talking points</p>
                            <ul className="ar-research__list">
                                {talkingPoints.map((point, index) => (
                                    <li key={`${index}-${point.slice(0, 24)}`}>{point}</li>
                                ))}
                            </ul>
                        </section>
                    )}

                    {risks.length > 0 && (
                        <section className="ar-research__section">
                            <p className="ar-research__label">Avoid claiming</p>
                            <ul className="ar-research__list ar-research__list--risks">
                                {risks.map((risk, index) => (
                                    <li key={`${index}-${risk.slice(0, 24)}`}>{risk}</li>
                                ))}
                            </ul>
                        </section>
                    )}

                    {(reviewCount !== null || estimatedVisitors !== null) && (
                        <section className="ar-research__section">
                            <p className="ar-research__label">Signals</p>
                            <div className="ar-research__stats">
                                {reviewCount !== null && (
                                    <div className="ar-research__stat">
                                        <span className="ar-research__stat-value">{reviewCount.toLocaleString("en-GB")}</span>
                                        <span className="ar-research__stat-label">Published reviews</span>
                                    </div>
                                )}
                                {estimatedVisitors !== null && (
                                    <div className="ar-research__stat" title="Rough DTC heuristic: published reviews × 100">
                                        <span className="ar-research__stat-value">~{estimatedVisitors.toLocaleString("en-GB")}</span>
                                        <span className="ar-research__stat-label">Est. site visitors</span>
                                    </div>
                                )}
                            </div>
                        </section>
                    )}

                    {sources.length > 0 && (
                        <section className="ar-research__section">
                            <p className="ar-research__label">Sources</p>
                            <ul className="ar-research__sources">
                                {sources.map((source) => {
                                    const host = hostnameOf(source.url);
                                    return (
                                        <li key={source.url}>
                                            <a
                                                className="ar-research__source"
                                                href={source.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                title={source.url}
                                            >
                                                <span className="ar-research__source-title">{source.title || source.url}</span>
                                                {host && <span className="ar-research__source-host">{host}</span>}
                                            </a>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    )}
                </>
            )}
        </div>
    );
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
    const [regenerateModalOpen, setRegenerateModalOpen] = useState(false);
    const [regenerateInstructions, setRegenerateInstructions] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [sendSuccess, setSendSuccess] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [threadOpen, setThreadOpen] = useState(false);

    const editorRef = useRef<HTMLDivElement>(null);
    const regenerateInstructionsRef = useRef<HTMLTextAreaElement>(null);
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
    // Touch devices have no ⌘K: when the caret sits in a link, float an
    // "Edit link" pill under it (document coordinates, like the popover).
    const [linkBubble, setLinkBubble] = useState<{ top: number; left: number } | null>(null);
    const linkBubbleRef = useRef<{ top: number; left: number } | null>(null);
    const [coarsePointer, setCoarsePointer] = useState(false);
    const bubbleRangeRef = useRef<Range | null>(null);

    const applyLoadedDraft = useCallback((loaded: ReviewDraft | null) => {
        if (!loaded) {
            setDraft(null);
            return;
        }
        const initialText = loaded.renderedText || "";
        const preparedText = prepareReplyEditorContent(initialText);
        lastSavedTextRef.current = preparedText;
        setDraft((prev) => ({
            ...loaded,
            thread: Array.isArray(loaded.thread) ? loaded.thread : prev?.thread ?? [],
        }));
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
                if (next.status === "researching") {
                    setDraft((prev) => prev
                        ? { ...prev, status: next.status, researchStep: next.researchStep ?? null }
                        : next);
                    return;
                }
                applyLoadedDraft(next);
                setError(null);
            } catch (err) {
                if (!cancelled) {
                    setRegenerating(false);
                    setError(err instanceof Error ? err.message : "Failed while waiting for regeneration");
                }
            }
        };
        const intervalId = setInterval(poll, 1000);
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

    // Close archive / regenerate modals on Escape
    useEffect(() => {
        if (!archiveModalOpen && !regenerateModalOpen) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            if (archiving || regenerating) return;
            if (regenerateModalOpen) setRegenerateModalOpen(false);
            else setArchiveModalOpen(false);
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [archiveModalOpen, regenerateModalOpen, archiving, regenerating]);

    useEffect(() => {
        if (!regenerateModalOpen) return;
        const id = window.setTimeout(() => regenerateInstructionsRef.current?.focus(), 0);
        return () => window.clearTimeout(id);
    }, [regenerateModalOpen]);

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

    const anchorAtNode = useCallback((node: Node | null | undefined): HTMLAnchorElement | null => {
        let el: Node | null = node instanceof Element ? node : node?.parentElement ?? null;
        while (el && el !== editorRef.current) {
            if (el instanceof HTMLAnchorElement) return el;
            el = el.parentElement;
        }
        return null;
    }, []);

    useEffect(() => {
        const media = window.matchMedia("(hover: none) and (pointer: coarse)");
        const update = () => setCoarsePointer(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, []);

    // Follow the caret: show the bubble under the link it sits in, hide otherwise.
    useEffect(() => {
        if (!coarsePointer) return;
        const handler = () => {
            const sel = window.getSelection();
            const editor = editorRef.current;
            const inside = Boolean(sel && editor && sel.anchorNode && editor.contains(sel.anchorNode));
            const anchor = inside ? anchorAtNode(sel?.anchorNode) : null;
            let next: { top: number; left: number } | null = null;
            if (anchor) {
                const rect = anchor.getBoundingClientRect();
                next = {
                    top: Math.round(rect.bottom + window.scrollY + 6),
                    left: Math.round(Math.max(8, Math.min(rect.left + window.scrollX, window.scrollX + window.innerWidth - 120))),
                };
            }
            const prev = linkBubbleRef.current;
            if ((prev === null && next === null) || (prev && next && prev.top === next.top && prev.left === next.left)) return;
            linkBubbleRef.current = next;
            setLinkBubble(next);
        };
        document.addEventListener("selectionchange", handler);
        return () => {
            document.removeEventListener("selectionchange", handler);
            linkBubbleRef.current = null;
            setLinkBubble(null);
        };
    }, [coarsePointer, anchorAtNode]);

    const openLinkPopup = useCallback((rangeOverride?: Range | null) => {
        const sel = window.getSelection();
        if (!sel) return;

        // A bubble tap can drop the editor selection; put the saved one back first.
        if (rangeOverride && (sel.rangeCount === 0 || !editorRef.current?.contains(sel.anchorNode))) {
            sel.removeAllRanges();
            sel.addRange(rangeOverride);
        }

        // Find the anchor the cursor is inside (if any)
        const anchor = anchorAtNode(sel.anchorNode);

        // Save the current selection range so we can restore it before execCommand
        const savedRange = sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;

        // Position the popover near the selection or anchor
        let rect: DOMRect | null = null;
        if (anchor) {
            rect = anchor.getBoundingClientRect();
        } else if (sel.rangeCount > 0) {
            rect = sel.getRangeAt(0).getBoundingClientRect();
        }
        // Keep the popover inside the viewport on narrow screens.
        const popupWidth = Math.min(400, window.innerWidth - 32);
        const maxLeft = window.scrollX + window.innerWidth - popupWidth - 16;
        const top = rect ? rect.bottom + window.scrollY + 8 : 200;
        const left = rect ? Math.max(8, Math.min(rect.left + window.scrollX, maxLeft)) : 80;

        setLinkPopup({
            url: anchor?.href ?? "",
            anchor,
            top,
            left,
            savedRange,
        });
        // Focus the input on next tick
        setTimeout(() => linkInputRef.current?.focus(), 0);
    }, [anchorAtNode]);

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
        setRegenerateModalOpen(false);
        setRegenerating(true);
        try {
            const extra = regenerateInstructions.trim();
            const response = await fetch(
                `${getPipelineBaseUrl()}/api/interested-autoresponder/review/${encodeURIComponent(token)}/regenerate`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        additionalInstructions: extra || undefined,
                    }),
                }
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

    const website = draft ? websiteFromDraft(draft) : null;
    const editorLocked = sendSuccess || regenerating;
    const actionsBusy = sending || regenerating || archiving;
    const hasDraftText = Boolean(String(draft?.renderedText || "").trim());
    // Right column only earns its space when there is (or will be) a brief.
    const showResearch = Boolean(draft && (regenerating || draft.researchBrief));
    const thread: ThreadMessage[] = draft?.thread ?? [];
    // The quote already shows the latest lead message; the thread adds value once there is more.
    const canExpandThread = thread.length > 1 || (thread.length === 1 && !draft?.previousLeadMessage);

    return (
        <main className="ar-page">
            {regenerateModalOpen && (
                <div
                    className="modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="regenerate-draft-title"
                    onClick={() => { if (!regenerating) setRegenerateModalOpen(false); }}
                >
                    <div className="modal" style={{ maxWidth: "560px" }} onClick={(e) => e.stopPropagation()}>
                        <div className="modal__header">
                            <div>
                                <p className="eyebrow eyebrow--muted">Interested Auto-Responder</p>
                                <h2 id="regenerate-draft-title" className="modal__title">Regenerate reply</h2>
                                <p className="modal__description">
                                    Optional extra instructions for this regeneration. They take priority over the campaign system prompt if anything conflicts.
                                </p>
                            </div>
                        </div>
                        <div className="modal__body">
                            <textarea
                                ref={regenerateInstructionsRef}
                                className="ar-textarea"
                                value={regenerateInstructions}
                                onChange={(e) => setRegenerateInstructions(e.target.value)}
                                onKeyDown={(e) => {
                                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                        e.preventDefault();
                                        if (!regenerating) handleRegenerate();
                                    }
                                }}
                                placeholder="e.g. Keep it under 80 words. Mention their new product line. Skip the audit link."
                                maxLength={4000}
                                disabled={regenerating}
                            />
                        </div>
                        <div className="modal__actions">
                            <button
                                type="button"
                                className="secondary-button secondary-button--active"
                                onClick={() => setRegenerateModalOpen(false)}
                                disabled={regenerating}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="primary-button"
                                onClick={handleRegenerate}
                                disabled={regenerating}
                            >
                                {regenerating ? "Regenerating…" : "Regenerate"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {archiveModalOpen && (
                <div
                    className="modal-overlay"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="archive-draft-title"
                    onClick={() => { if (!archiving) setArchiveModalOpen(false); }}
                >
                    <div className="modal" style={{ maxWidth: "480px" }} onClick={(e) => e.stopPropagation()}>
                        <div className="modal__header">
                            <div>
                                <p className="eyebrow eyebrow--muted">Interested Auto-Responder</p>
                                <h2 id="archive-draft-title" className="modal__title">Archive draft?</h2>
                                <p className="modal__description">
                                    This cancels the draft and invalidates this review link. You will not be able to send this reply from here.
                                </p>
                            </div>
                        </div>
                        <div className="modal__actions">
                            <button
                                type="button"
                                className="secondary-button secondary-button--active"
                                onClick={() => setArchiveModalOpen(false)}
                                disabled={archiving}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="destructive-button"
                                onClick={handleArchiveDraft}
                                disabled={archiving}
                            >
                                {archiving ? "Archiving…" : "Archive draft"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {coarsePointer && linkBubble && !linkPopup && !editorLocked && (
                <button
                    type="button"
                    className="ar-link-bubble"
                    style={{ top: linkBubble.top, left: linkBubble.left }}
                    // Keep focus and selection in the editor while tapping the bubble.
                    onPointerDown={(e) => {
                        e.preventDefault();
                        const sel = window.getSelection();
                        bubbleRangeRef.current = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
                    }}
                    onClick={() => openLinkPopup(bubbleRangeRef.current)}
                >
                    <Link2 size={13} strokeWidth={2} />
                    Edit link
                </button>
            )}
            {linkPopup && (
                <div
                    ref={linkPopupRef}
                    className="ar-link-popup"
                    style={{ top: linkPopup.top, left: linkPopup.left }}
                >
                    <span className="ar-link-popup__icon" aria-hidden="true">
                        <Link2 size={15} strokeWidth={2} />
                    </span>
                    <input
                        ref={linkInputRef}
                        type="url"
                        placeholder="https://"
                        aria-label="Link URL"
                        value={linkPopup.url}
                        onChange={(e) => setLinkPopup(p => p ? { ...p, url: e.target.value } : p)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); applyLink(linkPopup.url); }
                            if (e.key === "Escape") { e.preventDefault(); setLinkPopup(null); }
                        }}
                    />
                    <button type="button" className="ar-link-popup__btn" onClick={() => applyLink(linkPopup.url)}>Apply</button>
                    {linkPopup.anchor && (
                        <button type="button" className="ar-link-popup__btn ar-link-popup__btn--remove" onClick={() => applyLink("")}>Remove</button>
                    )}
                </div>
            )}

            <div className="ar-shell">
                {draft && !archived && (
                    <header className="ar-header">
                        <div className="ar-header__row">
                            <div className="ar-header__identity">
                                <h1 className="ar-header__title">{draft.leadEmail}</h1>
                                <p className="ar-header__meta">{draft.campaignName}</p>
                            </div>
                            <div className="ar-header__links">
                                {draft.phone?.number && (
                                    draft.phone.telUri ? (
                                        <a
                                            className="ar-link"
                                            href={draft.phone.telUri}
                                            title={draft.phone.country ? `Call (${draft.phone.country})` : "Call"}
                                        >
                                            <Phone size={15} strokeWidth={2} />
                                            {draft.phone.number}
                                        </a>
                                    ) : (
                                        <span className="ar-link ar-link--static">
                                            <Phone size={15} strokeWidth={2} />
                                            {draft.phone.number}
                                        </span>
                                    )
                                )}
                                {!draft.phone?.number && phoneStatusLabel(draft.phone?.status) && (
                                    <span className="ar-link ar-link--static ar-link--muted">
                                        <Phone size={15} strokeWidth={2} />
                                        {phoneStatusLabel(draft.phone?.status)}
                                    </span>
                                )}
                                {website && (
                                    <a
                                        className="ar-link"
                                        href={website.href}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title={website.domain}
                                    >
                                        <Globe size={15} strokeWidth={2} />
                                        Website
                                    </a>
                                )}
                                {previewUrl && (
                                    <a
                                        className="ar-link"
                                        href={previewUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        <ExternalLink size={15} strokeWidth={2} />
                                        Preview link
                                    </a>
                                )}
                            </div>
                        </div>
                    </header>
                )}

                {loading ? (
                    <div className="ar-panel">
                        <p className="ar-state">Loading…</p>
                    </div>
                ) : error && !draft ? (
                    <div className="ar-notice ar-notice--error" role="alert">{error}</div>
                ) : archived ? (
                    <div className="ar-notice ar-notice--muted">
                        This draft has been archived and is no longer available.
                    </div>
                ) : draft ? (
                    <div className={`ar-layout${showResearch ? " ar-layout--with-aside" : ""}`}>
                        <div className="ar-main">
                            {regenerating && (
                                <InterestedResearchProgress
                                    status={draft.status}
                                    stepId={draft.researchStep}
                                    tone="light"
                                />
                            )}
                            {/* Reply editor — rendered HTML, contentEditable */}
                            <div className="ar-editor-frame">
                                <div
                                    ref={editorRef}
                                    contentEditable={!editorLocked}
                                    suppressContentEditableWarning
                                    onInput={handleEditorInput}
                                    onBlur={handleEditorBlur}
                                    onPaste={handleEditorPaste}
                                    onKeyDown={handleEditorKeyDown}
                                    className="lead-reply-editor ar-editor"
                                    aria-label="Reply text"
                                />
                                {saveStatus === "saving" && (
                                    <span className="ar-save-state">Saving…</span>
                                )}
                                {saveStatus === "saved" && (
                                    <span className="ar-save-state ar-save-state--saved">Saved</span>
                                )}
                            </div>
                            <div className="ar-actions">
                                {!sendSuccess && (
                                    <button
                                        type="button"
                                        className="secondary-button secondary-button--active"
                                        onClick={() => setRegenerateModalOpen(true)}
                                        disabled={actionsBusy}
                                    >
                                        {regenerating
                                            ? (hasDraftText ? "Regenerating…" : "Researching…")
                                            : "Regenerate"}
                                    </button>
                                )}
                                {!sendSuccess && (
                                    <button
                                        type="button"
                                        className="destructive-button"
                                        onClick={() => setArchiveModalOpen(true)}
                                        disabled={actionsBusy}
                                    >
                                        Archive draft
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className="primary-button"
                                    onClick={handleSendReply}
                                    disabled={sending || regenerating || !renderedText.trim() || sendSuccess}
                                >
                                    {sending ? "Sending…" : sendSuccess ? "Sent ✓" : "Send reply"}
                                </button>
                            </div>
                            {sendSuccess && (
                                <div className="ar-notice ar-notice--success" role="status">
                                    Reply sent successfully.
                                </div>
                            )}
                            {error && (
                                <div className="ar-notice ar-notice--error" role="alert">
                                    {error}
                                </div>
                            )}

                            {/* Lead conversation: latest message, expandable to the whole thread */}
                            <section className="ar-conversation" aria-label="Lead conversation">
                                {threadOpen && thread.length > 0 ? (
                                    <ThreadView messages={thread} />
                                ) : draft.previousLeadMessage ? (
                                    <blockquote className="ar-quote">{draft.previousLeadMessage}</blockquote>
                                ) : (
                                    <p className="ar-quote ar-quote--empty">No prior lead message available.</p>
                                )}
                                {canExpandThread && (
                                    <button
                                        type="button"
                                        className="ar-thread-toggle"
                                        onClick={() => setThreadOpen((open) => !open)}
                                        aria-expanded={threadOpen}
                                    >
                                        {threadOpen ? <ChevronUp size={14} strokeWidth={2} /> : <ChevronDown size={14} strokeWidth={2} />}
                                        {threadOpen
                                            ? "Show latest message only"
                                            : `Show full thread · ${thread.length} ${thread.length === 1 ? "message" : "messages"}`}
                                    </button>
                                )}
                            </section>
                        </div>

                        {showResearch && (
                            <aside className="ar-aside">
                                <ResearchPanel
                                    brief={draft.researchBrief}
                                    completedAt={draft.researchCompletedAt}
                                    researching={regenerating}
                                />
                            </aside>
                        )}
                    </div>
                ) : (
                    <div className="ar-panel">
                        <p className="ar-state">Draft not found.</p>
                    </div>
                )}
            </div>
        </main>
    );
}
