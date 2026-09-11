"use client";

import {
  resolveWarmFollowUpProgress,
  WARM_FOLLOW_UP_PREVIEW_STEPS,
  WARM_FOLLOW_UP_STEPS,
} from "@server/services/warmFollowUpGeneration/steps.js";

type Tone = "light" | "dark";

type WarmFollowUpProgressProps = {
  status?: string | null;
  stepId?: string | null;
  mode?: "preview" | "send";
  tone?: Tone;
};

export function WarmFollowUpProgress({
  status,
  stepId,
  mode = "preview",
  tone = "light",
}: WarmFollowUpProgressProps) {
  const steps = mode === "send" ? WARM_FOLLOW_UP_STEPS : WARM_FOLLOW_UP_PREVIEW_STEPS;
  const progress = resolveWarmFollowUpProgress(status, stepId, mode);
  const current = steps[progress.currentIndex];
  const caption = progress.complete
    ? (String(status) === "failed" ? "Generation failed" : "Ready")
    : `${current?.label || "Load"} in progress`;

  return (
    <div
      className={`irp irp--${tone}`}
      role="status"
      aria-live="polite"
      aria-label={caption}
    >
      <ol className="irp__track">
        {steps.map((step, index) => {
          const state = progress.complete
            ? (String(status) === "failed" ? "todo" : "done")
            : index < progress.currentIndex
              ? "done"
              : index === progress.currentIndex
                ? "current"
                : "todo";
          return (
            <li key={step.id} className="irp__item" data-state={state}>
              {index > 0 && (
                <span className="irp__rail" aria-hidden="true">
                  <span
                    className="irp__rail-fill"
                    style={{ transform: `scaleX(${index <= progress.currentIndex || progress.complete ? 1 : 0})` }}
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
