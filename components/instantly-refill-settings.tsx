"use client";

import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "@/lib/supabase/session";
import { getPipelineBaseUrl } from "@/lib/pipeline/client";

type RefillSettings = {
  enabled: boolean;
  campaign_id: string | null;
  cooldown_days: number;
  backlog_days: number;
  last_run_at: string | null;
};

type RefillCapacity = {
  newLeadsPerDay: number;
  sendsPerDay: number;
  inboxes: number;
  steps: number;
  limitedBy: string;
};

type RefillState = {
  settings: RefillSettings;
  campaigns: Array<{ id: string; name: string; status: number | null }>;
  hasInstantlyKey: boolean;
  lastRun: {
    status: "running" | "completed" | "failed";
    trigger_source: string;
    started_at: string;
    completed_at: string | null;
    error: string | null;
    summary: {
      skipped?: string;
      backlog?: number;
      target?: number;
      need?: number;
      added?: number;
      failed?: number;
      lastError?: string | null;
      reverify?: { checked: number; valid: number; invalid: number; risky: number; unknown: number; error: string | null };
    };
  } | null;
};

type RefillPreview = {
  capacity: RefillCapacity | null;
  backlog: number;
  plan: { target: number; shortfall: number; need: number } | null;
  pool: { total: number; never_emailed: number; oldest_touch: string | null } | null;
};

const n = (value: number | undefined | null) => (value ?? 0).toLocaleString();

function describeRun(run: NonNullable<RefillState["lastRun"]>) {
  if (run.status === "running") return "in progress…";
  if (run.status === "failed") return `failed — ${run.error || "unknown error"}`;
  const s = run.summary;
  if (s.skipped) return `nothing to do (${s.skipped}).`;
  if (!s.need) return `backlog ${n(s.backlog)} already meets the target of ${n(s.target)}.`;
  const parts = [`added ${n(s.added)} of ${n(s.need)} needed (backlog was ${n(s.backlog)}, target ${n(s.target)})`];
  if (s.reverify?.checked) {
    parts.push(`re-verified ${n(s.reverify.checked)}: ${n(s.reverify.valid)} valid, ${n(s.reverify.invalid)} invalid, ${n((s.reverify.risky || 0) + (s.reverify.unknown || 0))} risky/unknown`);
  }
  if (s.reverify?.error) parts.push(`verification: ${s.reverify.error}`);
  if (s.failed) parts.push(`${n(s.failed)} failed to add (${s.lastError || "Instantly error"})`);
  return `${parts.join(" · ")}.`;
}

/**
 * Info tab: keeps one Instantly campaign's never-contacted backlog topped up
 * with past leads that have gone longest without an email.
 * Server: /api/clients/:clientId/instantly-refill (services/instantlyRefill.js).
 */
export function InstantlyRefillSettings({ clientId }: { clientId: string }) {
  const [state, setState] = useState<RefillState | null>(null);
  const [preview, setPreview] = useState<RefillPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [cooldownDraft, setCooldownDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(
    async (method: "GET" | "PUT" | "POST", path = "", body?: Record<string, unknown>) => {
      const token = await getAccessToken();
      if (!token) throw new Error("Session expired. Sign in again.");
      const res = await fetch(
        `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/instantly-refill${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      return data;
    },
    [clientId],
  );

  const load = useCallback(async () => {
    try {
      const data = (await request("GET")) as RefillState;
      setState(data);
      setCooldownDraft(String(data.settings.cooldown_days));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load refill settings.");
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  const running = state?.lastRun?.status === "running";
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(id);
  }, [running, load]);

  const loadPreview = async () => {
    setPreviewLoading(true);
    try {
      setPreview((await request("GET", "/preview")) as RefillPreview);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setPreviewLoading(false);
    }
  };

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      await request("PUT", "", patch);
      setPreview(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const onToggle = (enabled: boolean) => {
    if (enabled) {
      const ok = window.confirm(
        "Turn on automatic refill?\n\nEvery few hours it tops the campaign up with past leads that haven't been emailed in the longest time, re-verifying old emails with TryKitt first. Leads are added to Instantly and will be emailed.",
      );
      if (!ok) return;
    }
    void save({ enabled });
  };

  const commitCooldown = () => {
    const days = Number.parseInt(cooldownDraft, 10);
    if (!Number.isInteger(days) || days < 30 || days > 365) {
      setCooldownDraft(String(state?.settings.cooldown_days ?? 90));
      setError("Cooldown must be a whole number of days between 30 and 365.");
      return;
    }
    if (days !== state?.settings.cooldown_days) void save({ cooldownDays: days });
  };

  const runNow = async () => {
    if (!window.confirm("Run the refill now? Leads it adds go into the campaign and will be emailed.")) return;
    try {
      await request("POST", "/run");
      window.setTimeout(() => void load(), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the refill.");
    }
  };

  const settings = state?.settings;
  const disabled = !state || saving || !state.hasInstantlyKey;
  const run = state?.lastRun;

  return (
    <div className="settings-field instantly-cleanup">
      <span className="settings-field__label">Instantly lead refill</span>
      <span className="settings-field__hint">
        Keeps a campaign stocked so the inboxes never run out of new prospects. Every few hours it tops the
        campaign&apos;s never-contacted backlog up to a few days of sending capacity with valid leads that have gone
        longest without an email. It skips anyone (or anyone at the same company) who bounced, unsubscribed, replied
        or got a label other than out of office, plus companies emailed within the cooldown and anyone already in
        this campaign. Emails verified more than 90 days ago are re-verified with TryKitt first.
      </span>

      <div className="instantly-cleanup__controls">
        <label className="instantly-cleanup__toggle">
          <input
            type="checkbox"
            checked={settings?.enabled === true}
            disabled={disabled || (!settings?.enabled && !settings?.campaign_id)}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span>{settings?.enabled ? "On" : "Off"}</span>
        </label>
        <label className="instantly-cleanup__days">
          <span>Campaign</span>
          <select
            className="instantly-refill__select"
            value={settings?.campaign_id ?? ""}
            disabled={disabled}
            onChange={(e) => void save({ campaignId: e.target.value || null })}
          >
            <option value="">Select a campaign…</option>
            {(state?.campaigns ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.status === 1 ? "" : " (not active)"}
              </option>
            ))}
          </select>
        </label>
        <label className="instantly-cleanup__days">
          <span>Skip companies emailed in the last</span>
          <input
            type="number"
            min={30}
            max={365}
            value={cooldownDraft}
            disabled={disabled}
            onChange={(e) => setCooldownDraft(e.target.value)}
            onBlur={commitCooldown}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <span>days</span>
        </label>
        <label className="instantly-cleanup__days">
          <span>Keep</span>
          <select
            className="instantly-refill__select"
            value={settings?.backlog_days ?? 2}
            disabled={disabled}
            onChange={(e) => void save({ backlogDays: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5].map((d) => (
              <option key={d} value={d}>
                {d} day{d === 1 ? "" : "s"}
              </option>
            ))}
          </select>
          <span>of new prospects queued</span>
        </label>
      </div>

      <div className="instantly-cleanup__controls">
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || !settings?.campaign_id || previewLoading}
          onClick={() => void loadPreview()}
        >
          {previewLoading ? "Checking…" : "Check pool"}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || !settings?.campaign_id || running}
          onClick={() => void runNow()}
        >
          {running ? "Running…" : "Run now"}
        </button>
      </div>

      {!state?.hasInstantlyKey && state && (
        <p className="instantly-cleanup__line">Add an Instantly API key to this client first.</p>
      )}
      {error && <p className="instantly-cleanup__error">{error}</p>}

      {preview &&
        (preview.capacity ? (
          <p className="instantly-cleanup__line">
            Inboxes can start <strong>{n(preview.capacity.newLeadsPerDay)}</strong> new prospects/day (
            {n(preview.capacity.inboxes)} inboxes, {preview.capacity.steps} steps). Backlog{" "}
            <strong>{n(preview.backlog)}</strong> of a {n(preview.plan?.target)} target, so the next run adds about{" "}
            <strong>{n(preview.plan?.need)}</strong>. <strong>{n(preview.pool?.total)}</strong> eligible leads in the
            bank ({n(preview.pool?.never_emailed)} never emailed
            {preview.pool?.oldest_touch
              ? `; oldest last emailed ${new Date(preview.pool.oldest_touch).toLocaleDateString()}`
              : ""}
            ).
          </p>
        ) : (
          <p className="instantly-cleanup__line">The selected campaign isn&apos;t active in Instantly, so nothing will be added.</p>
        ))}

      {run && (
        <p className="instantly-cleanup__line">
          Last run {new Date(run.started_at).toLocaleString()}: {describeRun(run)}
        </p>
      )}
    </div>
  );
}
