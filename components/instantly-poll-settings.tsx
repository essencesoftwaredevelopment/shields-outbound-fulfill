"use client";

import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "@/lib/supabase/session";
import { getPipelineBaseUrl } from "@/lib/pipeline/client";
import { useConfirm } from "@/components/confirm-dialog";

type PollSummary = {
  seeded?: boolean;
  interested?: number;
  drafted?: number;
  followUps?: number;
  repliesStored?: number;
};

type PollSettings = {
  enabled: boolean;
  seeded_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  last_summary: PollSummary;
  webhook_linked: boolean;
  has_api_key: boolean;
};

/**
 * Info tab: poll Instantly for interested replies when a webhook cannot be linked.
 * Server: GET/PUT /api/clients/:clientId/instantly-poll (services/instantlyPollReconcile.js).
 */
export function InstantlyPollSettings({ clientId }: { clientId: string }) {
  const [settings, setSettings] = useState<PollSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const request = useCallback(
    async (method: "GET" | "PUT", body?: Record<string, unknown>) => {
      const token = await getAccessToken();
      if (!token) throw new Error("Session expired. Sign in again.");
      const res = await fetch(
        `${getPipelineBaseUrl()}/api/clients/${encodeURIComponent(clientId)}/instantly-poll`,
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
      const data = (await request("GET")) as { settings: PollSettings };
      setSettings(data.settings);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the reply poll.");
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (enabled: boolean) => {
    setSaving(true);
    try {
      await request("PUT", { enabled });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const onToggle = async (enabled: boolean) => {
    const ok = enabled
      ? await confirm({
          title: "Turn on the Instantly reply poll?",
          message:
            "The first pass only records who is already interested, so old leads are not notified. After that, new interested leads get the usual draft and ntfy alert about every 10 minutes.",
          confirmLabel: "Turn on reply poll",
          tone: "default",
        })
      : await confirm({
          title: "Turn off the Instantly reply poll?",
          message:
            "New interested leads will not be picked up until a webhook is linked or this is turned back on.",
          confirmLabel: "Turn off reply poll",
        });
    if (!ok) return;
    void save(enabled);
  };

  const enabled = settings?.enabled === true;
  const summary = settings?.last_summary;
  const summaryLine = !summary
    ? null
    : summary.seeded
      ? `First pass recorded ${(summary.interested ?? 0).toLocaleString()} interested lead(s). Nobody was notified.`
      : settings?.last_run_at
        ? `${(summary.interested ?? 0).toLocaleString()} interested · ${summary.drafted ?? 0} new drafts · ${summary.followUps ?? 0} follow-ups.`
        : null;

  return (
    <div className="settings-field instantly-cleanup">
      <span className="settings-field__label">Instantly reply poll</span>
      <span className="settings-field__hint">
        Use this when Instantly cannot send a webhook. About every 10 minutes the server checks for newly
        interested leads, saves the reply thread, and runs the same draft and ntfy alert as a webhook. The
        first run only records who is already interested. If a webhook is already linked, the poll stays idle.
      </span>

      <div className="instantly-cleanup__controls">
        <label className="instantly-cleanup__toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!settings || saving || !settings.has_api_key}
            onChange={(e) => void onToggle(e.target.checked)}
          />
          <span>{!settings ? "Loading…" : enabled ? "On" : "Off"}</span>
        </label>
      </div>

      {error && <p className="instantly-cleanup__error">{error}</p>}

      {settings && !settings.has_api_key && (
        <p className="instantly-cleanup__line">Add an Instantly API key before turning this on.</p>
      )}
      {settings?.webhook_linked && (
        <p className="instantly-cleanup__line">A webhook is already linked, so the poll stays idle.</p>
      )}
      {settings?.last_error && (
        <p className="instantly-cleanup__error">Last check failed: {settings.last_error}</p>
      )}
      {summaryLine && settings?.last_run_at && (
        <p className="instantly-cleanup__line">
          Last check {new Date(settings.last_run_at).toLocaleString()}: {summaryLine}
        </p>
      )}
      {confirmDialog}
    </div>
  );
}
