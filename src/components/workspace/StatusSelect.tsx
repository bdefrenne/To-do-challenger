"use client";

import { Check } from "lucide-react";
import type { TaskStatus } from "@/lib/types";
import { STATUS_LABEL, STATUS_ORDER, STATUS_TONE } from "@/lib/statuses";

/** Vertical status selector: every status is visible at once — Done included,
 *  since the modal has no separate done button — the current one highlighted;
 *  click one to switch. Picking Done is the caller's job to route through the
 *  /complete path (see the modal) so `completedAt` stays managed. */
export function StatusSelect({
  status,
  onChange,
  disabled = false,
}: {
  status: TaskStatus;
  onChange: (s: TaskStatus) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      {STATUS_ORDER.map((s) => {
        const t = STATUS_TONE[s];
        const current = s === status;
        return (
          <button
            key={s}
            type="button"
            disabled={disabled}
            onClick={() => onChange(s)}
            className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              current
                ? `${t.bg} ${t.text} ${t.border} font-semibold`
                : "border-border bg-surface-2 text-fg hover:bg-surface-3"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${t.dot}`} aria-hidden />
            <span className="truncate">{STATUS_LABEL[s]}</span>
            {current ? <span className="ml-auto text-accent"><Check aria-hidden size={13} strokeWidth={2.5} /></span> : null}
          </button>
        );
      })}
    </div>
  );
}
