"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

/** An identifier with a one-click copy button (e.g. the Pipeline tab's job ID). */
export function CopyableId({ value, label = "ID" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard blocked (permissions / insecure context): the value stays selectable.
    }
  };

  return (
    <span className="copyable-id">
      <span className="copyable-id__label">{label}</span>
      <code className="copyable-id__value">{value}</code>
      <button
        type="button"
        className="copyable-id__button"
        onClick={() => void copy()}
        title={copied ? "Copied" : `Copy ${label}`}
        aria-label={copied ? "Copied" : `Copy ${label}`}
      >
        {copied ? <Check size={13} strokeWidth={2.25} /> : <Copy size={13} strokeWidth={2} />}
      </button>
    </span>
  );
}
