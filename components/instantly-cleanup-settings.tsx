"use client";

import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "@/lib/supabase/session";
import { getPipelineBaseUrl } from "@/lib/pipeline/client";

type CleanupCategory =
  | "no_reply"
  | "out_of_office"
  | "not_interested"
  | "wrong_person"
  | "bad_fit"
  | "bounced"
  | "unsubscribed";

type CleanupState = {
  settings: { enabled: boolean; days: number; last_run_at: string | null };
  preview: {
    total: number;
    byCategory: Record<CleanupCategory, number>;
    campaigns: number;
    badFitLabelFound: boolean;
    labelsAvailable: boolean;
  } | null;
  previewError: string | null;
  lastRun: {
    status: "running" | "completed" | "failed";
    started_at: string;
    completed_at: string | null;
    error: string | null;
    summary: {
      deleted?: number;
      byCategory?: Partial<Record<CleanupCategory, number>>;
    };
  } | null;
};

const CATEGORY_LABELS: Record<CleanupCategory, string> = {
  not_interested: "not interested",
  bounced: "bounced",
  out_of_office: "out of office",
  bad_fit: "bad fit",
  no_reply: "no reply",
  wrong_person: "wrong person",
  unsubscribed: "unsubscribed",
};

const describeCategories = (counts: Partial<Record<CleanupCategory, number>> | undefined) =>
  Object.entries(counts || {})
    .filter(([, n]) => (n || 0) > 0)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .map(([key, n]) => `${(n || 0).toLocaleString()} ${CATEGORY_LABELS[key as CleanupCategory] ?? key}`)
    .join(" · ");

/**
 * Info tab: automatic deletion of finished Instantly leads for this client.
 * Server: GET/PUT /api/clients/:clientId/instantly-cleanup (services/instantlyCleanup.js).
 */
export function InstantlyCleanupSettings({ clientId }: { clientId: string }) {
  const [state, setState] = useState<CleanupState | null>(null);
  const [daysDraft, setDaysDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(
    async (method: "GET" | "PUT", body?: Record<string, unknown>) => {
      const token = await getAccessToken();
      if (!token) throw new Error("Session expired. Sign in again.");
      const res = await fetch(
        `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/instantly-cleanup`,
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
      const data = (await request("GET")) as CleanupState;
      setState(data);
      setDaysDraft(String(data.settings.days));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cleanup settings.");
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: { enabled?: boolean; days?: number }) => {
    setSaving(true);
    try {
      await request("PUT", patch);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const onToggle = (enabled: boolean) => {
    if (enabled) {
      const total = state?.preview?.total;
      const ok = window.confirm(
        `Turn on automatic cleanup?\n\n${
          typeof total === "number" ? `About ${total.toLocaleString()} lead(s) qualify right now. ` : ""
        }They are deleted from Instantly (this can't be undone there) right after the usual Instantly sync. Runs about once a day.`,
      );
      if (!ok) return;
    }
    void save({ enabled });
  };

  const commitDays = () => {
    const days = Number.parseInt(daysDraft, 10);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      setDaysDraft(String(state?.settings.days ?? 7));
      setError("Days must be a whole number between 1 and 365.");
      return;
    }
    if (days !== state?.settings.days) void save({ days });
  };

  const enabled = state?.settings.enabled === true;
  const run = state?.lastRun;

  return (
    <div className="settings-field instantly-cleanup">
      <span className="settings-field__label">Instantly lead cleanup</span>
      <span className="settings-field__hint">
        Deletes leads from Instantly once their own sequence is finished and they are out of office, not
        interested, bad fit, wrong person, bounced, unsubscribed, or completed without a reply. Campaigns keep
        running. Interested, meeting booked, warm follow-up and replied-but-unlabelled leads are always kept.
        Each run does the usual Instantly sync first, so everything is saved here before the leads are deleted.
      </span>

      <div className="instantly-cleanup__controls">
        <label className="instantly-cleanup__toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!state || saving}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span>{enabled ? "On" : "Off"}</span>
        </label>
        <label className="instantly-cleanup__days">
          <span>Delete after</span>
          <input
            type="number"
            min={1}
            max={365}
            value={daysDraft}
            disabled={!state || saving}
            onChange={(e) => setDaysDraft(e.target.value)}
            onBlur={commitDays}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
          <span>days since the lead&apos;s last email</span>
        </label>
      </div>

      {error && <p className="instantly-cleanup__error">{error}</p>}

      {state?.preview ? (
        <p className="instantly-cleanup__line">
          <strong>{state.preview.total.toLocaleString()}</strong> lead(s) qualify right now
          {state.preview.total > 0 ? ` — ${describeCategories(state.preview.byCategory)}` : ""}.
          {!state.preview.badFitLabelFound && state.preview.labelsAvailable && (
            <> No &ldquo;Bad Fit&rdquo; label in this workspace, so that category is skipped.</>
          )}
        </p>
      ) : state?.previewError ? (
        <p className="instantly-cleanup__line">Preview unavailable: {state.previewError}</p>
      ) : null}

      {run && (
        <p className="instantly-cleanup__line">
          Last run {new Date(run.started_at).toLocaleString()}:{" "}
          {run.status === "running"
            ? "in progress…"
            : run.status === "failed"
              ? `failed — ${run.error || "unknown error"}`
              : `deleted ${(run.summary.deleted ?? 0).toLocaleString()}${
                  run.summary.deleted ? ` (${describeCategories(run.summary.byCategory)})` : ""
                }.`}
        </p>
      )}
    </div>
  );
}
