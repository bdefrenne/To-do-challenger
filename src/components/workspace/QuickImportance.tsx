"use client";

/**
 * "Importance" trigger + keyboard-navigable picker for canvas Section task
 * cards. Same hover-then-keystroke pattern as <QuickStatus/> / <QuickAssign/>:
 * single-select, no text filter. Hidden until you hover the card (or while
 * open); open it by clicking, or by pressing the **I** keystroke while hovering:
 *
 *   • ↑ / ↓  — move the highlight
 *   • Enter  — pick the highlighted importance (and close)
 *   • Esc    — close
 *
 * The ladder is 2 High · 1 Elevated · 0 Normal (default) · -1 Low. Most tasks
 * stay Normal, so the trigger only draws attention once a non-Normal value is set.
 */

import { useEffect, useRef, useState } from "react";
import type { Importance } from "@/lib/types";
import { IMPORTANCE_LABEL, IMPORTANCE_ORDER, IMPORTANCE_TONE } from "@/lib/importance";
import { AnchoredPopover } from "./AnchoredPopover";
import { useCardShortcut } from "./useCardShortcut";

export function QuickImportance({
  importance,
  onChange,
  className = "",
}: {
  importance: Importance;
  onChange: (v: Importance) => void;
  /** Extra classes for the root. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Open with the current importance highlighted.
  const openFresh = () => {
    const i = IMPORTANCE_ORDER.findIndex((v) => v === importance);
    setActive(i < 0 ? 0 : i);
    setOpen(true);
  };

  // The "I" keystroke opens this picker when its card is hovered.
  useCardShortcut(rootRef, "i", openFresh);

  // Focus the popover on open so the arrow/Enter/Esc keys land here.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => popRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const pick = (v: Importance) => {
    onChange(v);
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
      setActive((a) => Math.min(a + 1, IMPORTANCE_ORDER.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const v = IMPORTANCE_ORDER[active];
      if (v !== undefined) pick(v);
    }
  };

  const tone = IMPORTANCE_TONE[importance];
  const notable = importance !== 0;

  return (
    <div
      ref={rootRef}
      className={[
        "relative shrink-0 transition-opacity",
        // A set importance stays visible; Normal only shows on hover/open.
        open || notable ? "opacity-100" : "opacity-0 group-hover/card:opacity-100",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      onDragStart={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        title="Importance (press I while hovering the card)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (open) setOpen(false);
          else openFresh();
        }}
        className={[
          "flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-medium transition-colors",
          open
            ? "border-accent bg-accent-soft text-accent"
            : `${tone.border} ${tone.bg} ${tone.text} hover:border-accent hover:text-accent`,
        ].join(" ")}
      >
        {IMPORTANCE_LABEL[importance]}
        <kbd className="rounded bg-surface-3 px-1 text-[9px] font-semibold leading-none text-faint">
          I
        </kbd>
      </button>

      <AnchoredPopover
        open={open}
        anchorRef={rootRef}
        onClose={() => setOpen(false)}
        align="right"
        className="w-40 rounded-lg border border-border bg-surface p-1 shadow-lg"
      >
        <div ref={popRef} tabIndex={-1} onKeyDown={onKeyDown} className="outline-none">
          {IMPORTANCE_ORDER.map((v, i) => {
            const t = IMPORTANCE_TONE[v];
            const current = v === importance;
            return (
              <button
                key={v}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(v)}
                className={[
                  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs",
                  i === active ? "bg-surface-2" : "",
                ].join(" ")}
              >
                <span className={`w-4 shrink-0 text-center font-mono ${t.text}`} aria-hidden>
                  {v > 0 ? `+${v}` : v}
                </span>
                <span className="flex-1 truncate text-fg">{IMPORTANCE_LABEL[v]}</span>
                {current ? <span className="text-accent">✓</span> : null}
              </button>
            );
          })}
        </div>
      </AnchoredPopover>
    </div>
  );
}
