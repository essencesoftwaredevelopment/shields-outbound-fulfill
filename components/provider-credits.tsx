"use client";

import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "@/lib/supabase/session";
import { supabase } from "@/lib/supabase/client";

type ProviderStatus = "unknown" | "ok" | "not_configured" | "error";

/** agency_provider_credits row (migration 0064). */
type ProviderCreditsRow = {
  agency_id: string;
  trykitt_status: ProviderStatus;
  trykitt_credits: number | null;
  trykitt_error: string | null;
  enrow_status: ProviderStatus;
  enrow_credits: number | null;
  enrow_error: string | null;
  fetched_at: string | null;
};

const formatUsd = (value: number) =>
  value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const formatCredits = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: value < 100 ? 2 : 0 });

/** Single coin: outer rim plus inner ring. */
const CoinIcon = () => (
  <svg
    className="provider-credits__coin"
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
  </svg>
);

// TryKitt's balance is a USD amount; Enrow's is a credit count.
const PROVIDERS = [
  { key: "trykitt", label: "TryKitt", format: formatUsd, coin: false },
  { key: "enrow", label: "Enrow", format: formatCredits, coin: true },
] as const;

/**
 * Remaining TryKitt / Enrow credits for the agency. The first read goes through
 * the server (which refreshes a stale row); after that, pipeline batches update
 * the row and Supabase Realtime pushes it here. Clicking a chip forces a refresh.
 */
export function ProviderCredits() {
  const [agencyId, setAgencyId] = useState<string | null>(null);
  const [row, setRow] = useState<ProviderCreditsRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (force: boolean) => {
    const token = await getAccessToken();
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`/internal/agency/credits${force ? "?refresh=1" : ""}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(String(res.status));
      const payload = (await res.json()) as { agencyId: string; row: ProviderCreditsRow | null };
      setAgencyId(payload.agencyId);
      if (payload.row) setRow(payload.row);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (!agencyId) return;
    const channel = supabase
      .channel(`provider-credits-${agencyId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agency_provider_credits",
          filter: `agency_id=eq.${agencyId}`,
        },
        (payload) => {
          const next = payload.new as ProviderCreditsRow | undefined;
          if (next?.agency_id) setRow(next);
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [agencyId]);

  const updated = row?.fetched_at
    ? `Updated ${new Date(row.fetched_at).toLocaleTimeString()} · click to refresh`
    : "Click to refresh";

  return (
    <div className="provider-credits" aria-live="polite">
      {PROVIDERS.map(({ key, label, format, coin }) => {
        const status = row?.[`${key}_status`];
        const credits = row?.[`${key}_credits`] ?? null;
        const error = row?.[`${key}_error`];
        let value = "…";
        let tone = "";
        let title = updated;
        let isAmount = false;
        if (status === "ok" && credits !== null) {
          value = format(credits);
          isAmount = true;
          if (credits <= 0) tone = " provider-credits__chip--empty";
        } else if (status === "not_configured") {
          value = "Not set up";
          tone = " provider-credits__chip--muted";
        } else if (status === "error") {
          // Keep the last known balance, flagged as possibly out of date.
          value = credits !== null ? format(credits) : "Unavailable";
          isAmount = credits !== null;
          tone = " provider-credits__chip--muted";
          title = `${label}: ${error || "lookup failed"} · click to retry`;
        } else if (failed && !row) {
          value = "Unavailable";
          tone = " provider-credits__chip--muted";
        }
        return (
          <button
            key={key}
            type="button"
            className={`provider-credits__chip${tone}`}
            onClick={() => void load(true)}
            disabled={loading}
            title={title}
          >
            <span className="provider-credits__label">{label}</span>
            <span className="provider-credits__value">
              {coin && isAmount && (
                <CoinIcon />
              )}
              {value}
            </span>
          </button>
        );
      })}
    </div>
  );
}
