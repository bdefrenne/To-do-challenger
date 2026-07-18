"use client";

import type { TaskStatus } from "@/lib/types";
import { STATUS_LABEL, STATUS_ORDER, STATUS_TONE } from "@/lib/statuses";

/** The in-flight statuses, shown as an always-visible vertical pick list.
 *  "done" is intentionally excluded — completion is driven by the Finished
 *  button so `completedAt` stays managed. */
const PICKABLE = STATUS_ORDER.filter((s) => s !== "done");

/** Vertical status selector: every in-flight status is visible at once, the
 *  current one highlighted; click one to switch. */
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
      {PICKABLE.map((s) => {
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
            {current ? <span className="ml-auto text-accent">✓</span> : null}
          </button>
        );
      })}
    </div>
  );
}
