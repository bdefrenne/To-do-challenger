"use client";

import { useEffect, useRef, useState } from "react";
import type { TaskStatus } from "@/lib/types";
import { STATUS_LABEL, STATUS_ORDER, STATUS_TONE } from "@/lib/statuses";

/** Clickable ClickUp-style status pill with a small change-status menu. */
export function StatusPill({
  status,
  onChange,
  compact = false,
}: {
  status: TaskStatus;
  onChange: (s: TaskStatus) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const tone = STATUS_TONE[status];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${tone.bg} ${tone.text} ${tone.border}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} aria-hidden />
        {compact ? null : <span className="truncate">{STATUS_LABEL[status]}</span>}
      </button>

      {open ? (
        <div className="absolute z-40 mt-1 w-48 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-lg">
          {STATUS_ORDER.map((s) => {
            const t = STATUS_TONE[s];
            return (
              <button
                key={s}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(s);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-2 ${s === status ? "font-semibold" : ""}`}
              >
                <span className={`h-2 w-2 rounded-full ${t.dot}`} aria-hidden />
                <span className="text-fg">{STATUS_LABEL[s]}</span>
                {s === status ? <span className="ml-auto text-accent">✓</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
