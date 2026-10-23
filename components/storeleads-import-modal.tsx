"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiJson } from "@/lib/api/http";
import { AppMultiSelect, AppSelect } from "@/components/app-select";
import { DatePicker } from "@/components/date-picker";

type Segment = {
    minMonthlySales: string;
    maxMonthlySales: string;
    countries: string[];
    platforms: string[];
    technologies: string;
    technologiesMatch: "any" | "all";
    excludeTechnologies: string;
    states: string[];
    createdAfter: string;
    customDomainsOnly: boolean;
};

type ImportBatch = {
    id: string;
    fileName: string | null;
    status: "processing" | "completed" | "failed";
    mode?: "export" | "backfill" | null;
    stalled?: boolean;
    totalRows: number;
    processedRows: number;
    createdCount: number;
    updatedCount: number;
    skippedCount: number;
    error: string | null;
};

type StatusPayload = {
    hasKey: boolean;
    activeBatchId: string | null;
    backfillCandidates: number | null;
    maxSegments: number;
};

type PreviewPayload = { counts: number[]; labels: string[]; total: number };

const COUNTRY_OPTIONS = [
    ["US", "United States"], ["CA", "Canada"], ["GB", "United Kingdom"], ["AU", "Australia"],
    ["NZ", "New Zealand"], ["IE", "Ireland"], ["DE", "Germany"], ["FR", "France"],
    ["NL", "Netherlands"], ["BE", "Belgium"], ["ES", "Spain"], ["IT", "Italy"],
    ["SE", "Sweden"], ["DK", "Denmark"], ["NO", "Norway"], ["CH", "Switzerland"],
    ["AE", "United Arab Emirates"], ["SG", "Singapore"], ["MX", "Mexico"], ["BR", "Brazil"]
].map(([value, name]) => ({ value, label: `${name} (${value})` }));

const PLATFORM_OPTIONS = ["shopify", "woocommerce", "bigcommerce", "magento", "wix", "squarespace"]
    .map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }));

const STATE_OPTIONS = ["Active", "Inactive", "Password Protected"].map((value) => ({ value, label: value }));

const STALE_DAY_OPTIONS = [
    { value: "30", label: "Never synced, or synced 30+ days ago" },
    { value: "90", label: "Never synced, or synced 90+ days ago" },
    { value: "0", label: "Every domain (full refresh)" }
];

function defaultSegment(): Segment {
    return {
        minMonthlySales: "50000",
        maxMonthlySales: "",
        countries: ["US", "CA"],
        platforms: [],
        technologies: "",
        technologiesMatch: "any",
        excludeTechnologies: "",
        states: ["Active"],
        createdAfter: "",
        customDomainsOnly: true
    };
}

function splitNames(value: string) {
    return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function toRequestSegment(segment: Segment) {
    return {
        minMonthlySales: segment.minMonthlySales ? Number(segment.minMonthlySales) : null,
        maxMonthlySales: segment.maxMonthlySales ? Number(segment.maxMonthlySales) : null,
        countries: segment.countries,
        platforms: segment.platforms,
        technologies: splitNames(segment.technologies),
        technologiesMatch: segment.technologiesMatch,
        excludeTechnologies: splitNames(segment.excludeTechnologies),
        states: segment.states,
        createdAfter: segment.createdAfter ? segment.createdAfter.slice(0, 10) : null,
        customDomainsOnly: segment.customDomainsOnly
    };
}

/** Rough wall-clock for a bulk backfill: 100 domains per call at ~4 calls/s. */
function formatBackfillEstimate(domains: number) {
    const seconds = Math.ceil(domains / 100) * 0.3;
    if (seconds < 90) return "about a minute";
    const minutes = Math.round(seconds / 60);
    return minutes < 90 ? `about ${minutes} minutes` : `about ${Math.round(minutes / 60)} hours`;
}

const sectionLabelStyle = {
    fontSize: "0.78rem",
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase" as const,
    color: "var(--app-text-faint)"
};

export function StoreLeadsImportModal({
    open,
    clientId,
    onClose,
    onFinished
}: {
    open: boolean;
    clientId: string;
    onClose: () => void;
    onFinished: (batch: ImportBatch) => void;
}) {
    const [mode, setMode] = useState<"export" | "backfill">("export");
    const [segments, setSegments] = useState<Segment[]>(() => [defaultSegment()]);
    const [existingStrategy, setExistingStrategy] = useState<"update" | "skip">("update");
    const [staleDays, setStaleDays] = useState("30");
    const [status, setStatus] = useState<StatusPayload | null>(null);
    const [preview, setPreview] = useState<PreviewPayload | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [starting, setStarting] = useState(false);
    const [batch, setBatch] = useState<ImportBatch | null>(null);
    const [error, setError] = useState("");

    const loadStatus = useCallback(async (days: string, { resumeActive = false } = {}) => {
        try {
            const params = new URLSearchParams({ clientId, staleDays: days });
            const next = await apiJson<StatusPayload>(`/api/storeleads/status?${params.toString()}`);
            setStatus(next);
            if (resumeActive && next.activeBatchId) {
                // Reopened while a run continues in the background: show its progress.
                // A run for another client 404s here and stays a "busy" notice instead.
                const batchParams = new URLSearchParams({ clientId });
                const active = await apiJson<{ batch: ImportBatch }>(
                    `/api/leads/import/batches/${next.activeBatchId}?${batchParams.toString()}`
                ).catch(() => null);
                if (active?.batch) {
                    if (active.batch.mode) setMode(active.batch.mode);
                    setBatch(active.batch);
                }
            }
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : "Failed to load Store Leads status.");
        }
    }, [clientId]);

    useEffect(() => {
        if (!open) return;
        setBatch(null);
        setPreview(null);
        setError("");
        void loadStatus(staleDays, { resumeActive: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, loadStatus]);

    // Poll the run like a CSV import batch until it finishes.
    useEffect(() => {
        if (!open || !batch || batch.status !== "processing") return;
        let cancelled = false;
        const interval = window.setInterval(async () => {
            try {
                const params = new URLSearchParams({ clientId });
                const data = await apiJson<{ batch: ImportBatch }>(`/api/leads/import/batches/${batch.id}?${params.toString()}`);
                if (cancelled || !data?.batch) return;
                setBatch(data.batch);
                if (data.batch.status !== "processing") onFinished(data.batch);
            } catch {
                // Transient; the next tick retries.
            }
        }, 2000);
        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, batch?.id, batch?.status, clientId]);

    const updateSegment = (index: number, patch: Partial<Segment>) => {
        setPreview(null);
        setSegments((prev) => prev.map((segment, i) => (i === index ? { ...segment, ...patch } : segment)));
    };

    const requestSegments = useMemo(() => segments.map(toRequestSegment), [segments]);

    const handlePreview = async () => {
        setPreviewLoading(true);
        setError("");
        try {
            setPreview(await apiJson<PreviewPayload>("/api/storeleads/preview", {
                method: "POST",
                body: JSON.stringify({ segments: requestSegments })
            }));
        } catch (previewError) {
            setError(previewError instanceof Error ? previewError.message : "Preview failed.");
        } finally {
            setPreviewLoading(false);
        }
    };

    const handleStart = async () => {
        setStarting(true);
        setError("");
        try {
            const body = mode === "backfill"
                ? { clientId, mode, staleDays: Number(staleDays) }
                : { clientId, mode, segments: requestSegments, existingStrategy };
            const data = await apiJson<{ batch: ImportBatch }>("/api/storeleads/import", {
                method: "POST",
                body: JSON.stringify(body)
            });
            setBatch({ ...data.batch, mode });
        } catch (startError) {
            setError(startError instanceof Error ? startError.message : "Failed to start the import.");
        } finally {
            setStarting(false);
        }
    };

    if (!open) return null;

    const running = batch?.status === "processing";
    const blockedByOtherRun = Boolean(status?.activeBatchId && status.activeBatchId !== batch?.id);
    const maxSegments = status?.maxSegments ?? 3;

    return (
        <div
            className="modal-overlay"
            role="dialog"
            aria-modal="true"
            onClick={() => { if (!starting) onClose(); }}
        >
            <div
                className="modal"
                onClick={(event) => event.stopPropagation()}
                style={{ maxWidth: "820px", maxHeight: "92vh", display: "flex", flexDirection: "column" }}
            >
                <div className="modal__header">
                    <div>
                        <h2 className="modal__title">🛍️ Import from Store Leads</h2>
                        <p className="modal__description">
                            Pull stores that match your filters into this lead bank, or refresh monthly sales, country and apps for the domains already here. Nothing is enriched; new stores arrive as empty leads you can filter by import batch and enrich.
                        </p>
                    </div>
                </div>

                <div className="modal__body" style={{ display: "flex", flexDirection: "column", gap: "1.25rem", overflowY: "auto" }}>
                    {status && !status.hasKey && (
                        <p className="form-error" role="alert">
                            Add your Store Leads API key in the vault (home page → API keys) first. It needs a Store Leads plan with API access.
                        </p>
                    )}

                    {!batch && (
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                            {(["export", "backfill"] as const).map((value) => (
                                <button
                                    key={value}
                                    type="button"
                                    className={`secondary-button${mode === value ? " secondary-button--active" : ""}`}
                                    onClick={() => { setMode(value); setError(""); }}
                                >
                                    {value === "export" ? "Find new stores" : "Backfill existing leads"}
                                </button>
                            ))}
                        </div>
                    )}

                    {!batch && mode === "export" && (
                        <>
                            {segments.map((segment, index) => (
                                <div
                                    key={index}
                                    style={{
                                        padding: "1rem",
                                        border: "1px solid var(--app-border)",
                                        borderRadius: "10px",
                                        background: "var(--app-surface-3)",
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: "0.85rem"
                                    }}
                                >
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                        <span style={sectionLabelStyle}>
                                            {segments.length > 1 ? `Segment ${index + 1}${index > 0 ? " (OR)" : ""}` : "Filters"}
                                        </span>
                                        {segments.length > 1 && (
                                            <button
                                                type="button"
                                                className="secondary-button"
                                                onClick={() => {
                                                    setPreview(null);
                                                    setSegments((prev) => prev.filter((_, i) => i !== index));
                                                }}
                                            >
                                                Remove
                                            </button>
                                        )}
                                    </div>

                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "0.75rem" }}>
                                        <label className="settings-field">
                                            <span className="settings-field__label">Min monthly sales ($)</span>
                                            <input
                                                type="number"
                                                min={0}
                                                placeholder="No minimum"
                                                value={segment.minMonthlySales}
                                                onChange={(event) => updateSegment(index, { minMonthlySales: event.target.value })}
                                            />
                                        </label>
                                        <label className="settings-field">
                                            <span className="settings-field__label">Max monthly sales ($)</span>
                                            <input
                                                type="number"
                                                min={0}
                                                placeholder="No maximum"
                                                value={segment.maxMonthlySales}
                                                onChange={(event) => updateSegment(index, { maxMonthlySales: event.target.value })}
                                            />
                                        </label>
                                        <div className="settings-field">
                                            <span className="settings-field__label">Countries</span>
                                            <AppMultiSelect
                                                values={segment.countries}
                                                options={COUNTRY_OPTIONS}
                                                placeholder="Any country"
                                                onChange={(values) => updateSegment(index, { countries: values })}
                                            />
                                        </div>
                                        <div className="settings-field">
                                            <span className="settings-field__label">Platforms</span>
                                            <AppMultiSelect
                                                values={segment.platforms}
                                                options={PLATFORM_OPTIONS}
                                                placeholder="Any platform"
                                                onChange={(values) => updateSegment(index, { platforms: values })}
                                            />
                                        </div>
                                        <div className="settings-field">
                                            <span className="settings-field__label">Store status</span>
                                            <AppMultiSelect
                                                values={segment.states}
                                                options={STATE_OPTIONS}
                                                placeholder="Any status"
                                                onChange={(values) => updateSegment(index, { states: values })}
                                            />
                                        </div>
                                        <div className="settings-field">
                                            <span className="settings-field__label">First seen on or after</span>
                                            <DatePicker
                                                value={segment.createdAfter}
                                                placeholder="Any time"
                                                onChange={(value) => updateSegment(index, { createdAfter: value })}
                                            />
                                        </div>
                                    </div>

                                    <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0.75rem" }}>
                                        <label className="settings-field">
                                            <span className="settings-field__label">Uses technologies / apps</span>
                                            <input
                                                type="text"
                                                placeholder="e.g. Klaviyo, Recharge"
                                                value={segment.technologies}
                                                onChange={(event) => updateSegment(index, { technologies: event.target.value })}
                                            />
                                            <span className="settings-field__hint">Comma-separated, named exactly as Store Leads lists them.</span>
                                        </label>
                                        <div className="settings-field">
                                            <span className="settings-field__label">Match</span>
                                            <AppSelect
                                                value={segment.technologiesMatch}
                                                options={[
                                                    { value: "any", label: "Any of them" },
                                                    { value: "all", label: "All of them" }
                                                ]}
                                                onChange={(value) => updateSegment(index, { technologiesMatch: value as "any" | "all" })}
                                            />
                                        </div>
                                    </div>
                                    <label className="settings-field">
                                        <span className="settings-field__label">Exclude stores using</span>
                                        <input
                                            type="text"
                                            placeholder="e.g. Attentive"
                                            value={segment.excludeTechnologies}
                                            onChange={(event) => updateSegment(index, { excludeTechnologies: event.target.value })}
                                        />
                                        <span className="settings-field__hint">Applied after download, so the match count below includes these stores.</span>
                                    </label>
                                    <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", fontSize: "0.9rem" }}>
                                        <input
                                            type="checkbox"
                                            checked={segment.customDomainsOnly}
                                            onChange={(event) => updateSegment(index, { customDomainsOnly: event.target.checked })}
                                            style={{ width: "16px", height: "16px" }}
                                        />
                                        Custom domains only (skip *.myshopify.com style stores)
                                    </label>
                                </div>
                            ))}

                            {segments.length < maxSegments && (
                                <button
                                    type="button"
                                    className="secondary-button"
                                    style={{ alignSelf: "flex-start" }}
                                    onClick={() => {
                                        setPreview(null);
                                        setSegments((prev) => [...prev, { ...defaultSegment(), minMonthlySales: "", technologies: "Klaviyo" }]);
                                    }}
                                >
                                    + Add OR segment
                                </button>
                            )}

                            <label className="settings-field">
                                <span className="settings-field__label">Stores already in this lead bank</span>
                                <AppSelect
                                    value={existingStrategy}
                                    options={[
                                        { value: "update", label: "Refresh their store data (sales, country, apps)" },
                                        { value: "skip", label: "Leave them untouched — only add new domains" }
                                    ]}
                                    onChange={(value) => setExistingStrategy(value as "update" | "skip")}
                                />
                                <span className="settings-field__hint">Existing leads keep their founder, email and campaign data either way.</span>
                            </label>

                            {preview && (
                                <div style={{ padding: "0.85rem 1rem", border: "1px solid var(--app-border)", borderRadius: "10px", fontSize: "0.9rem" }}>
                                    <div style={{ fontWeight: 600, color: "var(--app-text)" }}>
                                        {preview.total.toLocaleString()} matching stores in Store Leads
                                    </div>
                                    {preview.counts.length > 1 && (
                                        <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem", color: "var(--app-text-muted)" }}>
                                            {preview.counts.map((count, i) => (
                                                <li key={i}>{preview.labels[i]}: {count.toLocaleString()}</li>
                                            ))}
                                        </ul>
                                    )}
                                    <div style={{ marginTop: "0.35rem", color: "var(--app-text-muted)" }}>
                                        Stores in more than one segment are imported once.
                                        {preview.counts.length > 1 ? " Each extra segment adds a 1-minute wait (Store Leads export limit)." : ""}
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    {!batch && mode === "backfill" && (
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
                            <label className="settings-field">
                                <span className="settings-field__label">Which domains</span>
                                <AppSelect
                                    value={staleDays}
                                    options={STALE_DAY_OPTIONS}
                                    onChange={(value) => {
                                        setStaleDays(value);
                                        void loadStatus(value);
                                    }}
                                />
                            </label>
                            <div style={{ padding: "0.85rem 1rem", border: "1px solid var(--app-border)", borderRadius: "10px", fontSize: "0.9rem", color: "var(--app-text-muted)" }}>
                                {status?.backfillCandidates == null
                                    ? "Counting domains…"
                                    : status.backfillCandidates === 0
                                        ? "Every domain in this lead bank was synced recently."
                                        : <>
                                            <strong style={{ color: "var(--app-text)" }}>{status.backfillCandidates.toLocaleString()}</strong> domains will be looked up in Store Leads ({formatBackfillEstimate(status.backfillCandidates)}). Domains Store Leads doesn&apos;t know are marked “Not Found” so they aren&apos;t looked up again.
                                        </>}
                            </div>
                        </div>
                    )}

                    {batch && (
                        <div style={{ padding: "1rem", background: "var(--app-surface-3)", border: "1px solid var(--app-border)", borderRadius: "10px" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem", gap: "1rem" }}>
                                <span style={{ fontWeight: 600, color: "var(--app-text)" }}>
                                    {batch.status === "processing" && (batch.stalled
                                        ? "⚠️ Import appears stalled — start it again to resume"
                                        : batch.processedRows === 0 && mode === "export"
                                            ? "⏳ Store Leads is preparing the export…"
                                            : "⏳ Importing…")}
                                    {batch.status === "completed" && "✅ Import complete"}
                                    {batch.status === "failed" && "❌ Import failed"}
                                </span>
                                <span style={{ color: "var(--app-text-muted)", fontSize: "0.85rem", whiteSpace: "nowrap" }}>
                                    {batch.processedRows.toLocaleString()} / {Math.max(batch.totalRows, batch.processedRows).toLocaleString()} stores
                                </span>
                            </div>
                            <div style={{ height: "6px", borderRadius: "3px", background: "var(--app-surface-2)", overflow: "hidden" }}>
                                <div style={{
                                    height: "100%",
                                    width: `${Math.min(100, Math.round((batch.processedRows / Math.max(1, batch.totalRows)) * 100))}%`,
                                    background: batch.status === "failed" ? "var(--app-danger-solid)" : "var(--app-info-solid)",
                                    transition: "width 0.4s ease"
                                }} />
                            </div>
                            <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", marginTop: "0.75rem", fontSize: "0.875rem", color: "var(--app-text-muted)" }}>
                                {mode === "export" && (
                                    <span><strong style={{ color: "var(--app-success-text)" }}>{batch.createdCount.toLocaleString()}</strong> new leads</span>
                                )}
                                <span><strong style={{ color: "var(--app-text)" }}>{batch.updatedCount.toLocaleString()}</strong> {mode === "export" ? "existing refreshed" : "updated"}</span>
                                <span><strong style={{ color: "var(--app-warn-text)" }}>{batch.skippedCount.toLocaleString()}</strong> {mode === "export" ? "skipped" : "not found in Store Leads"}</span>
                            </div>
                            {batch.error && <p className="form-error" role="alert" style={{ marginTop: "0.75rem" }}>{batch.error}</p>}
                            {batch.status === "completed" && mode === "export" && batch.createdCount > 0 && (
                                <p style={{ margin: "0.75rem 0 0", fontSize: "0.85rem", color: "var(--app-text-muted)" }}>
                                    Filter the leads table with <strong>Import Batch = {batch.fileName || `#${batch.id}`}</strong>, then use “Enrich filtered” to find founders and emails for the new stores.
                                </p>
                            )}
                        </div>
                    )}

                    {blockedByOtherRun && !batch && (
                        <p className="form-error" role="alert">Another Store Leads import is running for this agency. Wait for it to finish.</p>
                    )}
                    {error && <p className="form-error" role="alert">{error}</p>}
                </div>

                <div className="modal__actions">
                    {!batch && mode === "export" && (
                        <button
                            type="button"
                            className="secondary-button"
                            onClick={handlePreview}
                            disabled={previewLoading || starting || !status?.hasKey}
                        >
                            {previewLoading ? "Counting…" : "Check matches"}
                        </button>
                    )}
                    {!batch && (
                        <button
                            type="button"
                            className="primary-button"
                            onClick={handleStart}
                            disabled={
                                starting
                                || !status?.hasKey
                                || blockedByOtherRun
                                || (mode === "backfill" && !status?.backfillCandidates)
                            }
                        >
                            {starting
                                ? "Starting…"
                                : mode === "backfill"
                                    ? `Backfill ${status?.backfillCandidates ? status.backfillCandidates.toLocaleString() : ""} domains`
                                    : preview
                                        ? `Import ${preview.total.toLocaleString()} stores`
                                        : "Import stores"}
                        </button>
                    )}
                    <button type="button" className="secondary-button" onClick={onClose} disabled={starting}>
                        {running ? "Continue in background" : "Close"}
                    </button>
                </div>
            </div>
        </div>
    );
}
