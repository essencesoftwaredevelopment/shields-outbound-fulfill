"use client";

import { CircleAlert } from "lucide-react";
import { TRYKITT_CREDITS_URL } from "@/lib/pipeline/creditExhaustion";

type CreditExhaustionNoticeProps = {
  fileName?: string | null;
  selected: boolean;
  resuming?: boolean;
  compact?: boolean;
  onResume?: () => void;
  onOpenJob?: () => void;
};

export function CreditExhaustionNotice({
  fileName,
  selected,
  resuming = false,
  compact = false,
  onResume,
  onOpenJob,
}: CreditExhaustionNoticeProps) {
  const jobLabel = fileName?.trim() || "This job";

  return (
    <div
      className={`credit-exhaustion-notice${compact ? " credit-exhaustion-notice--compact" : ""}`}
      role="status"
      aria-live="polite"
    >
      <CircleAlert
        className="credit-exhaustion-notice__icon"
        size={compact ? 16 : 20}
        strokeWidth={1.75}
        aria-hidden="true"
      />
      <div className="credit-exhaustion-notice__body">
        <p className="credit-exhaustion-notice__title">TryKitt credits exhausted</p>
        <p className="credit-exhaustion-notice__text">
          {jobLabel} is paused. Add credits, then resume to finish email discovery.
        </p>
      </div>
      <div className="credit-exhaustion-notice__actions">
        {selected && onResume ? (
          <button
            type="button"
            className="credit-exhaustion-notice__btn credit-exhaustion-notice__btn--primary"
            onClick={onResume}
            disabled={resuming}
          >
            {resuming ? "Resuming..." : "Resume job"}
          </button>
        ) : onOpenJob ? (
          <button
            type="button"
            className="credit-exhaustion-notice__btn credit-exhaustion-notice__btn--primary"
            onClick={onOpenJob}
          >
            Open job
          </button>
        ) : null}
        <a
          className="credit-exhaustion-notice__btn credit-exhaustion-notice__btn--ghost"
          href={TRYKITT_CREDITS_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Add credits
        </a>
      </div>
    </div>
  );
}
