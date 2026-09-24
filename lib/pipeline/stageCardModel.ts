import type { PipelineStageKey, PipelineStageState } from "@/lib/pipeline/types";

/**
 * What a Pipeline-tab stage card shows. Every card has the same anatomy — one
 * hero number, one detail line, a cost footer — so the logic lives here instead
 * of in per-stage JSX branches.
 *
 * Inputs are the stages as the page holds them: normally the live
 * get_job_stage_counts mapping (lib/enrichment/stageCounts.ts), before that the
 * server-reconciled jobs.stages. Both share the summary keys read below.
 */
export type StageCardTone = "pending" | "running" | "completed" | "error" | "skipped";

export type StageCardModel = {
  tone: StageCardTone;
  chip: string;
  /** null renders an em dash (nothing to count yet / not run). */
  hero: number | null;
  heroLabel: string;
  detail: string;
  /** null = this stage never costs anything; a number (even 0) = show it. */
  cost: number | null;
  creditExhausted: boolean;
};

/** Stages billed per request/token. The rest are free (DNS, local matching). */
const COSTED_STAGES = new Set<PipelineStageKey>([
  "founders",
  "emailDiscovery",
  "verification",
  "personalization",
  "serperShopping",
]);

type Bag = Record<string, unknown> | null | undefined;

const pickNumber = (bag: Bag, keys: string[]): number | null => {
  if (!bag) return null;
  for (const key of keys) {
    const value = bag[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
};

const fmt = (value: number) => value.toLocaleString();
const pct = (part: number, whole: number, digits = 0) =>
  whole > 0 ? `${((part / whole) * 100).toFixed(digits)}%` : "0%";

const parseCost = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value.replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

export const stageCost = (stage?: PipelineStageState | null): number | null => {
  if (!stage) return null;
  const summary = stage.summary as Bag;
  const progress = stage.progress as Bag;
  for (const value of [summary?.cost, summary?.Cost, summary?.["Estimated Cost"], progress?.cost, progress?.Cost]) {
    const parsed = parseCost(value);
    if (parsed !== null && parsed >= 0) return parsed;
  }
  return null;
};

/** "$0.84"; sub-cent spend keeps a third decimal so it doesn't read as free. */
export const formatStageCost = (cost: number) =>
  `$${cost > 0 && cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`;

const CREDIT_EXHAUSTION_PATTERN = /out of credits|add credits to trykitt|credit.?exhaust/i;

export function buildStageCardModel(
  stageKey: PipelineStageKey,
  stage: PipelineStageState | null | undefined,
  opts: { upstreamTitle?: string | null; personalizeFirstLine?: boolean } = {},
): StageCardModel {
  const summary = stage?.summary as Bag;
  const progress = stage?.progress as Bag;
  const stats = progress?.stats as Bag;
  const status = stage?.status ?? "pending";
  const skipped = summary?.skipped === true;
  const imported = pickNumber(summary, ["imported"]);
  // A skipped stage whose data came from the upload still does real work.
  const fromCsv = skipped && imported !== null && (imported > 0 || status !== "completed");
  const waiting = opts.upstreamTitle ? `Waiting for ${opts.upstreamTitle}` : "Queued";

  const base: StageCardModel = {
    tone: status === "error" ? "error" : status,
    chip: status === "running" ? "Running" : status === "completed" ? "Completed" : status === "error" ? "Error" : "Pending",
    hero: null,
    heroLabel: "",
    detail: waiting,
    cost: COSTED_STAGES.has(stageKey) ? stageCost(stage) ?? (status === "pending" ? null : 0) : null,
    creditExhausted: typeof stage?.error === "string" && CREDIT_EXHAUSTION_PATTERN.test(stage.error),
  };

  if (status === "error") {
    return {
      ...base,
      detail: base.creditExhausted ? "Out of TryKitt credits — add credits, then resume." : stage?.error || "Stage failed",
    };
  }

  if (skipped && !fromCsv) {
    const notEnabled = stageKey === "personalization" && opts.personalizeFirstLine !== true;
    return {
      ...base,
      tone: "skipped",
      chip: "Skipped",
      detail: notEnabled ? "Not enabled for this job" : "Not run for this job",
      cost: null,
    };
  }
  if (fromCsv) {
    base.chip = status === "completed" ? "From CSV" : status === "running" ? "Importing" : "Pending";
  }

  const started = status !== "pending";

  switch (stageKey) {
    case "domainPrep": {
      const checkSkipped = summary?.domainCheckSkipped === true;
      const processable = pickNumber(summary, ["processable"]) ?? pickNumber(progress, ["total"]);
      const checked = pickNumber(summary, ["checked"]) ?? 0;
      const live = pickNumber(summary, ["live"]) ?? 0;
      const dead = pickNumber(summary, ["dead"]) ?? 0;
      const unknown = pickNumber(summary, ["unknown"]) ?? 0;
      return {
        ...base,
        hero: started || processable ? processable ?? 0 : null,
        heroLabel: "Processable",
        detail: checkSkipped
          ? "DNS check skipped"
          : checked > 0
            ? [`${fmt(checked)} checked`, `${fmt(live)} live`, `${fmt(dead)} dead`, unknown > 0 ? `${fmt(unknown)} unresolved` : null]
                .filter(Boolean)
                .join(" · ")
            : started
              ? "Checking domains…"
              : "Queued",
      };
    }

    case "founders": {
      const found = pickNumber(summary, ["found", "Found", "imported"]) ?? pickNumber(progress, ["found"]) ?? 0;
      const processed = pickNumber(summary, ["processed"]) ?? pickNumber(progress, ["processed"]) ?? 0;
      const total = pickNumber(progress, ["total"]) ?? 0;
      if (fromCsv) {
        return { ...base, hero: found, heroLabel: "Imported", detail: found > 0 ? `${fmt(found)} names from CSV` : "Importing names from CSV…" };
      }
      if (!started && processed === 0) return { ...base };
      const searched = status === "running" && total > processed ? `${fmt(processed)} of ${fmt(total)} searched` : `${fmt(processed)} searched`;
      return { ...base, hero: found, heroLabel: "Found", detail: `${searched} · ${pct(found, processed)} yield` };
    }

    case "emailDiscovery": {
      const found = pickNumber(stats, ["Found", "found"]) ?? pickNumber(summary, ["found", "Found", "imported"]) ?? 0;
      const notFound = pickNumber(stats, ["Not Found"]) ?? pickNumber(summary, ["notFound", "Not Found"]) ?? 0;
      const errors = pickNumber(stats, ["errors"]) ?? pickNumber(summary, ["errors", "Errors"]) ?? 0;
      const processed = pickNumber(summary, ["processed"]) ?? pickNumber(progress, ["processed"]) ?? 0;
      const attempted = Math.max(processed, found + notFound + errors);
      if (fromCsv) {
        return {
          ...base,
          hero: found,
          heroLabel: "Imported",
          detail: found > 0
            ? `${fmt(found)} from CSV${notFound > 0 ? ` · ${fmt(notFound)} already on another lead` : ""}`
            : "Importing emails from CSV…",
        };
      }
      if (!started && attempted === 0) return { ...base };
      return {
        ...base,
        hero: found,
        heroLabel: "Emails found",
        detail: attempted > 0
          ? `${fmt(attempted)} searched · ${pct(found, attempted, 1)} hit rate${errors > 0 ? ` · ${fmt(errors)} errors` : ""}`
          : "Searching…",
      };
    }

    case "verification": {
      const valid = pickNumber(stats, ["valid", "Valid"]) ?? pickNumber(summary, ["valid", "Valid"]) ?? 0;
      const risky = pickNumber(summary, ["valid-risky", "Valid-Risky"]) ?? pickNumber(stats, ["valid-risky"]) ?? 0;
      const invalid = pickNumber(summary, ["invalid", "Invalid"]) ?? pickNumber(stats, ["invalid"]) ?? 0;
      const unknown = pickNumber(summary, ["unknown", "Unknown"]) ?? pickNumber(stats, ["unknown"]) ?? 0;
      const checked = pickNumber(summary, ["processed", "verified", "Verified"]) ?? pickNumber(progress, ["processed"]) ?? 0;
      if (fromCsv) {
        return { ...base, hero: valid + risky, heroLabel: "Verified", detail: checked > 0 ? `${fmt(valid)} valid · statuses from CSV` : "Importing statuses from CSV…" };
      }
      if (!started && checked === 0) return { ...base };
      if (status === "completed" && checked === 0) {
        return { ...base, hero: 0, heroLabel: "Verified", detail: "No emails to verify" };
      }
      return {
        ...base,
        hero: valid + risky,
        heroLabel: "Verified",
        detail: [
          `${fmt(checked)} checked`,
          invalid > 0 ? `${fmt(invalid)} invalid` : null,
          risky > 0 ? `${fmt(risky)} risky` : null,
          unknown > 0 ? `${fmt(unknown)} unknown` : null,
        ].filter(Boolean).join(" · "),
      };
    }

    case "personalization": {
      const personalized = pickNumber(stats, ["personalized", "Personalized"]) ?? pickNumber(summary, ["personalized", "Personalized"]) ?? 0;
      const eligible = pickNumber(summary, ["eligible"]) ?? pickNumber(progress, ["candidates", "total"]) ?? 0;
      const failed = pickNumber(summary, ["failed"]) ?? pickNumber(stats, ["failed"]) ?? 0;
      if (!started && personalized === 0) return { ...base };
      if (status === "completed" && eligible === 0 && personalized === 0) {
        return { ...base, hero: 0, heroLabel: "Ready", detail: "No verified leads to personalize" };
      }
      return {
        ...base,
        hero: personalized,
        heroLabel: "Ready",
        detail: `${fmt(personalized)} of ${fmt(Math.max(eligible, personalized))} personalized${failed > 0 ? ` · ${fmt(failed)} failed` : ""}`,
      };
    }

    case "serperShopping": {
      const matched = pickNumber(summary, ["matched", "clean"]) ?? 0;
      const none = pickNumber(summary, ["none"]) ?? 0;
      const ambiguous = pickNumber(summary, ["ambiguous"]) ?? 0;
      const processed = pickNumber(summary, ["processed"]) ?? matched + none + ambiguous;
      if (!started && processed === 0) return { ...base };
      return {
        ...base,
        hero: matched,
        heroLabel: "Ads matched",
        detail: [`${fmt(processed)} queried`, `${fmt(none)} no match`, ambiguous > 0 ? `${fmt(ambiguous)} ambiguous` : null]
          .filter(Boolean)
          .join(" · "),
      };
    }

    case "signalWaterfall": {
      const signals = pickNumber(summary, ["signals"]) ?? pickNumber(stats, ["signals"]) ?? pickNumber(summary, ["processed"]) ?? 0;
      const candidates = pickNumber(summary, ["totalCandidates"]) ?? pickNumber(progress, ["total"]) ?? 0;
      if (!started && signals === 0) return { ...base };
      return {
        ...base,
        hero: signals,
        heroLabel: "Signals",
        detail: candidates > 0 ? `${fmt(signals)} of ${fmt(candidates)} stores` : `${fmt(signals)} emitted`,
      };
    }

    default: {
      const processed = pickNumber(progress, ["processed"]) ?? 0;
      const total = pickNumber(progress, ["total"]) ?? 0;
      if (!started && processed === 0) return { ...base };
      return { ...base, hero: processed, heroLabel: "Processed", detail: total > 0 ? `${fmt(processed)} of ${fmt(total)}` : "" };
    }
  }
}
