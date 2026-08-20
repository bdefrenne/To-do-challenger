"use client";

/**
 * "Status" trigger + keyboard-navigable status picker for canvas Section task
 * cards. Same hover-then-keystroke pattern as <QuickAssign/>, but single-select
 * and with no text filter. Hidden until you hover the card (or while open); open
 * it by clicking, or by pressing the **S** keystroke while hovering the card:
 *
 *   • ↑ / ↓  — move the highlight
 *   • Enter  — pick the highlighted status (and close)
 *   • Esc    — close
 *
 * "Complete" is intentionally absent — done/undone is driven by the **D**
 * keystroke on the card (which manages `completedAt`), so the picker only offers
 * the in-flight statuses.
 */

import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TaskStatus } from "@/lib/types";
import { STATUS_LABEL, STATUS_ORDER, STATUS_TONE } from "@/lib/statuses";
import { AnchoredPopover } from "./AnchoredPopover";
import { useCardShortcut } from "./useCardShortcut";

const PICKABLE = STATUS_ORDER.filter((s) => s !== "done");

export function QuickStatus({
  status,
  onChange,
  className = "",
  revealOnHover = true,
  renderTrigger,
}: {
  status: TaskStatus;
  onChange: (s: TaskStatus) => void;
  /** Extra classes for the root. */
  className?: string;
  /** When true (canvas/kanban default), the trigger is hidden until card-hover.
   *  Set false on always-scannable surfaces like the list table. */
  revealOnHover?: boolean;
  /** Replace the default canvas-style trigger button with a caller-supplied one
   *  (e.g. the list's own status pill). The popover + keyboard shortcut are
   *  unchanged; `toggle` opens/closes the same picker. */
  renderTrigger?: (state: {
    open: boolean;
    toggle: (e: React.MouseEvent) => void;
  }) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Open with the current status highlighted.
  const openFresh = () => {
    const i = PICKABLE.findIndex((s) => s === status);
    setActive(i < 0 ? 0 : i);
    setOpen(true);
  };

  // The "S" keystroke opens this picker when its card is hovered.
  useCardShortcut(rootRef, "s", openFresh);

  // Focus the popover on open so the arrow/Enter/Esc keys land here.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => popRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const pick = (s: TaskStatus) => {
    onChange(s);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, PICKABLE.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const s = PICKABLE[active];
      if (s) pick(s);
    }
  };

  const tone = STATUS_TONE[status];

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) setOpen(false);
    else openFresh();
  };

  return (
    <div
      ref={rootRef}
      className={[
        "relative shrink-0 transition-opacity",
        open || !revealOnHover ? "opacity-100" : "opacity-0 group-hover/card:opacity-100",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      onDragStart={(e) => e.stopPropagation()}
    >
      {renderTrigger ? (
        renderTrigger({ open, toggle })
      ) : (
        <button
          type="button"
          title="Status (press S while hovering the card)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={toggle}
          className={[
            "flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-medium transition-colors",
            open
              ? "border-accent bg-accent-soft text-accent"
              : "border-border bg-surface-2 text-muted hover:border-accent hover:text-accent",
          ].join(" ")}
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} aria-hidden />
          {STATUS_LABEL[status]}
          <kbd className="rounded bg-surface-3 px-1 text-[9px] font-semibold leading-none text-faint">
            S
          </kbd>
        </button>
      )}

      <AnchoredPopover
        open={open}
        anchorRef={rootRef}
        onClose={() => setOpen(false)}
        align="right"
        className="w-40 rounded-lg border border-border bg-surface p-1 shadow-lg"
      >
        <div ref={popRef} tabIndex={-1} onKeyDown={onKeyDown} className="outline-none">
          {PICKABLE.map((s, i) => {
            const t = STATUS_TONE[s];
            const current = s === status;
            return (
              <button
                key={s}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(s)}
                className={[
                  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs",
                  i === active ? "bg-surface-2" : "",
                ].join(" ")}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${t.dot}`} aria-hidden />
                <span className="flex-1 truncate text-fg">{STATUS_LABEL[s]}</span>
                {current ? <span className="text-accent"><Check aria-hidden size={13} strokeWidth={2.5} /></span> : null}
              </button>
            );
          })}
        </div>
      </AnchoredPopover>
    </div>
  );
}
