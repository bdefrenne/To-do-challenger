"use client";

import { ChevronRight } from "lucide-react";

/**
 * One bucket's header: a full-width gradient band with white text — the rule you
 * scan the page by, and the hit target that folds everything under it away.
 * Filled rather than outlined so it reads as a CUT through the content; an
 * outlined header at this size just looks like another card.
 *
 * Shared by the Boards view (one band per placement bucket) and the Done view
 * (one band per week, per day, and per board), which is why the gradient arrives
 * as `bar` rather than being looked up here — each view owns its own ramp, and
 * `size` lets a nested band step down without inventing a second component.
 */
export function SeparatorHeader({
  title,
  count,
  bar,
  collapsed,
  onToggle,
  size = "lg",
  right,
  bleed = false,
}: {
  title: string;
  count: number;
  bar: string;
  collapsed: boolean;
  onToggle: () => void;
  /** `lg` is the top-level rule; `sm` is a band nested inside one. */
  size?: "lg" | "sm";
  /** Optional trailing content, right-aligned — e.g. a day's avatars. */
  right?: React.ReactNode;
  /**
   * Run the band edge to edge instead of sitting inside the page gutter: square
   * corners, and the label inset by the gutter so it still lines up with the
   * page's text. For callers that have already broken out of the gutter with a
   * negative margin.
   */
  bleed?: boolean;
}) {
  const sm = size === "sm";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className={[
        // Tailwind v4 gives buttons the default cursor, so every clickable
        // element in this repo asks for the pointer itself.
        "flex w-full cursor-pointer items-center gap-3 text-left text-white shadow-sm transition-opacity hover:opacity-90",
        bleed ? "rounded-none" : "rounded-lg",
        sm ? (bleed ? "px-8 py-1.5" : "px-3 py-1.5") : bleed ? "px-8 py-3" : "px-4 py-3",
        bar,
      ].join(" ")}
    >
      <span
        aria-hidden
        className={[
          "text-xs transition-transform",
          collapsed ? "" : "rotate-90",
        ].join(" ")}
      >
        <ChevronRight size={14} strokeWidth={2} />
      </span>
      <span
        className={[
          "font-bold uppercase tracking-[0.12em]",
          sm ? "text-xs" : "text-sm",
        ].join(" ")}
      >
        {title}
      </span>
      {/* Translucent white rather than a fixed color, so one pill style works on
          every bar in the ramp. */}
      <span className="nums rounded-full bg-white/25 px-2 py-0.5 text-xs font-semibold">
        {count}
      </span>
      {right ? <span className="ml-auto flex items-center">{right}</span> : null}
    </button>
  );
}
