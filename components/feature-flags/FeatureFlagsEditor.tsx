"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiJson } from "@/lib/api/http";

type Scalar = string | number | boolean;
type FeatureValue = Scalar | Record<string, unknown> | unknown[] | null;
type Features = Record<string, FeatureValue>;

interface RegistryField {
    key: string;
    type: "number" | "string";
    label: string;
    min?: number | null;
    placeholder?: string | null;
}

interface RegistryFlag {
    key: string;
    group: string;
    type: "boolean" | "enum" | "number" | "object";
    label: string;
    description: string;
    default: Scalar | null;
    options: { value: string; label: string }[] | null;
    fields: RegistryField[] | null;
    min: number | null;
    envOverride: string | null;
    envOverrideActive: boolean;
}

interface Registry {
    groups: { id: string; label: string }[];
    flags: RegistryFlag[];
}

interface FeaturesResponse {
    agencyId: string;
    features: Features;
    registry: Registry;
    canEdit: boolean;
}

interface FeatureFlagsEditorProps {
    /** Omit to load/edit the signed-in user's own agency. */
    agencyId?: string;
    onSaved?: (features: Features) => void;
}

function endpointsFor(agencyId?: string) {
    return agencyId
        ? `/api/admin/agencies/${encodeURIComponent(agencyId)}/features`
        : "/api/agency/features";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameValue(a: FeatureValue | undefined, b: FeatureValue | undefined): boolean {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function FeatureFlagsEditor({ agencyId, onSaved }: FeatureFlagsEditorProps) {
    const endpoint = endpointsFor(agencyId);
    const [data, setData] = useState<FeaturesResponse | null>(null);
    const [saved, setSaved] = useState<Features>({});
    const [draft, setDraft] = useState<Features>({});
    const [rawOther, setRawOther] = useState("{}");
    const [rawOtherError, setRawOtherError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await apiJson<FeaturesResponse>(endpoint);
            setData(response);
            setSaved(response.features || {});
            setDraft(response.features || {});
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load features.");
        } finally {
            setLoading(false);
        }
    }, [endpoint]);

    useEffect(() => {
        void load();
    }, [load]);

    const knownKeys = useMemo(() => new Set((data?.registry.flags ?? []).map((f) => f.key)), [data]);

    // Keys present in the DB that the registry doesn't describe.
    const otherSaved = useMemo(() => {
        const out: Features = {};
        for (const [k, v] of Object.entries(saved)) if (!knownKeys.has(k)) out[k] = v;
        return out;
    }, [saved, knownKeys]);

    useEffect(() => {
        setRawOther(JSON.stringify(otherSaved, null, 2));
        setRawOtherError(null);
    }, [otherSaved]);

    const canEdit = data?.canEdit === true;

    function setKey(key: string, value: FeatureValue | undefined) {
        setDraft((prev) => {
            const next = { ...prev };
            if (value === undefined) delete next[key];
            else next[key] = value;
            return next;
        });
        setNotice(null);
    }

    const patch = useMemo(() => {
        const out: Record<string, FeatureValue> = {};
        for (const key of knownKeys) {
            const before = saved[key];
            const after = draft[key];
            if (sameValue(before, after)) continue;
            out[key] = after === undefined ? null : after;
        }
        // Raw "other" JSON: diff against saved unknown keys.
        let parsedOther: Features | null = null;
        try {
            const parsed: unknown = JSON.parse(rawOther || "{}");
            if (!isPlainObject(parsed)) throw new Error("must be a JSON object");
            parsedOther = parsed as Features;
        } catch {
            parsedOther = null;
        }
        if (parsedOther) {
            for (const [k, v] of Object.entries(parsedOther)) {
                if (knownKeys.has(k)) continue;
                if (!sameValue(otherSaved[k], v)) out[k] = v;
            }
            for (const k of Object.keys(otherSaved)) {
                if (!(k in parsedOther)) out[k] = null;
            }
        }
        return out;
    }, [saved, draft, knownKeys, rawOther, otherSaved]);

    const dirty = Object.keys(patch).length > 0;

    async function save() {
        if (!canEdit || !dirty) return;
        try {
            const parsed: unknown = JSON.parse(rawOther || "{}");
            if (!isPlainObject(parsed)) throw new Error("Other keys must be a JSON object.");
            for (const k of Object.keys(parsed)) {
                if (knownKeys.has(k)) throw new Error(`"${k}" is a known flag — edit it above, not in the raw JSON.`);
            }
        } catch (err) {
            setRawOtherError(err instanceof Error ? err.message : "Invalid JSON.");
            return;
        }
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
            const response = await apiJson<{ features: Features }>(endpoint, {
                method: "PATCH",
                body: JSON.stringify({ patch }),
            });
            setSaved(response.features || {});
            setDraft(response.features || {});
            setNotice("Saved.");
            onSaved?.(response.features || {});
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to save features.");
        } finally {
            setSaving(false);
        }
    }

    function reset() {
        setDraft(saved);
        setRawOther(JSON.stringify(otherSaved, null, 2));
        setRawOtherError(null);
        setNotice(null);
        setError(null);
    }

    if (loading && !data) {
        return <p style={{ color: "var(--app-text-muted)" }}>Loading features…</p>;
    }
    if (!data) {
        return (
            <div>
                <p className="auth-card__error">{error || "Failed to load features."}</p>
                <button type="button" className="df-btn" onClick={() => void load()}>Retry</button>
            </div>
        );
    }

    return (
        <div className="ff">
            {!canEdit && (
                <p className="ff__readonly">
                    Read-only — feature flags are changed by a platform admin.
                </p>
            )}

            {data.registry.groups.map((group) => {
                const flags = data.registry.flags.filter((f) => f.group === group.id);
                if (flags.length === 0) return null;
                return (
                    <section key={group.id} className="ff__group">
                        <h3 className="ff__group-title">{group.label}</h3>
                        <div className="ff__list">
                            {flags.map((flag) => (
                                <FlagRow
                                    key={flag.key}
                                    flag={flag}
                                    value={draft[flag.key]}
                                    savedValue={saved[flag.key]}
                                    disabled={!canEdit || saving}
                                    onChange={(value) => setKey(flag.key, value)}
                                />
                            ))}
                        </div>
                    </section>
                );
            })}

            <section className="ff__group">
                <h3 className="ff__group-title">Other keys</h3>
                <p className="df-hint" style={{ marginBottom: "0.5rem" }}>
                    Keys stored on this agency that aren&apos;t in the registry above. Edit as JSON; remove a key to unset it.
                </p>
                <textarea
                    className="df-textarea ff__raw"
                    rows={Math.min(12, Math.max(3, rawOther.split("\n").length))}
                    value={rawOther}
                    onChange={(event) => { setRawOther(event.target.value); setRawOtherError(null); setNotice(null); }}
                    disabled={!canEdit || saving}
                    spellCheck={false}
                    aria-label="Other feature keys (JSON)"
                />
                {rawOtherError && <p className="df-error">{rawOtherError}</p>}
            </section>

            {error && <p className="df-error">{error}</p>}
            {notice && <p className="ff__notice">{notice}</p>}

            {canEdit && (
                <div className="ff__actions">
                    <button type="button" className="primary-button" onClick={() => void save()} disabled={!dirty || saving}>
                        {saving ? "Saving…" : dirty ? `Save ${Object.keys(patch).length} change${Object.keys(patch).length === 1 ? "" : "s"}` : "Saved"}
                    </button>
                    <button type="button" className="df-btn df-btn--ghost" onClick={reset} disabled={!dirty || saving}>
                        Discard
                    </button>
                </div>
            )}
        </div>
    );
}

interface FlagRowProps {
    flag: RegistryFlag;
    value: FeatureValue | undefined;
    savedValue: FeatureValue | undefined;
    disabled: boolean;
    onChange: (value: FeatureValue | undefined) => void;
}

function describeDefault(flag: RegistryFlag): string {
    if (flag.type === "boolean") return flag.default ? "on" : "off";
    if (flag.type === "enum") return flag.options?.find((o) => o.value === flag.default)?.label ?? String(flag.default ?? "—");
    if (flag.type === "number") return String(flag.default ?? "—");
    return "host defaults";
}

function FlagRow({ flag, value, savedValue, disabled, onChange }: FlagRowProps) {
    const isSet = value !== undefined && value !== null;
    const changed = !sameValue(value, savedValue);

    let control: React.ReactNode;
    if (flag.type === "boolean") {
        const effective = isSet ? value === true : flag.default === true;
        control = (
            <label className="ff__switch">
                <input
                    type="checkbox"
                    role="switch"
                    aria-checked={effective}
                    checked={effective}
                    disabled={disabled}
                    onChange={(event) => onChange(event.target.checked)}
                />
                <span>{effective ? "On" : "Off"}</span>
            </label>
        );
    } else if (flag.type === "enum") {
        const current = isSet ? String(value) : String(flag.default ?? "");
        control = (
            <select
                className="df-select"
                value={current}
                disabled={disabled}
                onChange={(event) => onChange(event.target.value)}
                aria-label={flag.label}
            >
                {flag.options?.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                ))}
            </select>
        );
    } else if (flag.type === "number") {
        control = (
            <input
                className="df-input ff__number"
                type="number"
                step="any"
                min={flag.min ?? undefined}
                value={isSet ? String(value) : ""}
                placeholder={String(flag.default ?? "")}
                disabled={disabled}
                onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === "") onChange(undefined);
                    else {
                        const n = Number(raw);
                        onChange(Number.isFinite(n) ? n : undefined);
                    }
                }}
                aria-label={flag.label}
            />
        );
    } else {
        const obj = isPlainObject(value) ? value : {};
        control = (
            <div className="ff__fields">
                {(flag.fields ?? []).map((field) => (
                    <label key={field.key} className="ff__field">
                        <span className="ff__field-label">{field.label}</span>
                        <input
                            className="df-input"
                            type={field.type === "number" ? "number" : "text"}
                            step={field.type === "number" ? "any" : undefined}
                            min={field.type === "number" ? field.min ?? undefined : undefined}
                            value={obj[field.key] === undefined || obj[field.key] === null ? "" : String(obj[field.key])}
                            placeholder={field.placeholder ?? ""}
                            disabled={disabled}
                            onChange={(event) => {
                                const raw = event.target.value;
                                const next: Record<string, unknown> = { ...obj };
                                if (raw === "") delete next[field.key];
                                else next[field.key] = field.type === "number" ? Number(raw) : raw;
                                onChange(Object.keys(next).length ? (next as FeatureValue) : undefined);
                            }}
                        />
                    </label>
                ))}
            </div>
        );
    }

    return (
        <div className={`ff__row${changed ? " ff__row--changed" : ""}`}>
            <div className="ff__row-text">
                <div className="ff__row-head">
                    <span className="ff__row-label">{flag.label}</span>
                    <code className="ff__key">{flag.key}</code>
                    {isSet ? (
                        <span className="df-pill df-pill--sky">Set</span>
                    ) : (
                        <span className="ff__default">default: {describeDefault(flag)}</span>
                    )}
                    {flag.envOverrideActive && (
                        <span className="df-pill df-pill--violet" title={`${flag.envOverride} is set on the host and overrides this flag for every agency`}>
                            Env override active
                        </span>
                    )}
                </div>
                <p className="ff__row-desc">{flag.description}</p>
            </div>
            <div className="ff__row-control">
                {control}
                {isSet && !disabled && (
                    <button type="button" className="ff__clear" onClick={() => onChange(undefined)} title="Remove the stored value and fall back to the default">
                        Use default
                    </button>
                )}
            </div>
        </div>
    );
}
