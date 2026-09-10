"use client";

import { INTERESTED_RESEARCH_STEPS, resolveResearchProgress } from "@server/services/interestedResearch/steps.js";

type Tone = "light" | "dark";

type InterestedResearchProgressProps = {
  status?: string | null;
  stepId?: string | null;
  tone?: Tone;
  /** Dots and connecting line only — for the narrow Pending Review column. */
  compact?: boolean;
};

export function InterestedResearchProgress({
  status,
  stepId,
  tone = "light",
  compact = false,
}: InterestedResearchProgressProps) {
  if (String(status || "") !== "researching") return null;

  const progress = resolveResearchProgress(status, stepId);
  const currentIndex = progress.currentIndex;
  const current = INTERESTED_RESEARCH_STEPS[currentIndex];
  const caption = `${current?.label || "Load"} in progress`;

  return (
    <div
      className={`irp irp--${tone}${compact ? " irp--compact" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={caption}
    >
      <ol className="irp__track">
        {INTERESTED_RESEARCH_STEPS.map((step, index) => {
          const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
          return (
            <li key={step.id} className="irp__item" data-state={state}>
              {index > 0 && (
                <span className="irp__rail" aria-hidden="true">
                  <span
                    className="irp__rail-fill"
                    style={{ transform: `scaleX(${index <= currentIndex ? 1 : 0})` }}
                  />
                </span>
              )}
              <span className="irp__dot" aria-hidden="true" />
              <span className="irp__label">{step.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="irp__caption">{caption}</p>
    </div>
  );
}
