"use client";

/**
 * A popover panel that renders in a **portal at `document.body`** and positions
 * itself against an anchor element. This exists because the canvas Section cards
 * that host our pickers ([QuickAssign]/[QuickStatus]) sit inside three stacked
 * `overflow-hidden` ancestors (canvas root → card → card body), which clip any
 * in-flow `absolute` popover — and `z-index` can't defeat overflow clipping.
 * Portaling escapes all of them, plus the canvas's CSS transform.
 *
 * Positioning uses the anchor's `getBoundingClientRect()` (screen coords, already
 * post-transform), so the panel lands on the trigger at normal size at any zoom.
 * It opens downward, flipping above when it would overflow the viewport bottom,
 * and re-measures on scroll/resize while open. It also owns outside-click close
 * (clicks inside the anchor OR the panel are ignored), replacing the near-
 * identical effects the pickers used to carry.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

/** Gap in px between the anchor and the panel. */
const GAP = 4;

interface Pos {
  top: number;
  left?: number;
  right?: number;
}

export function AnchoredPopover({
  open,
  anchorRef,
  onClose,
  align = "right",
  className = "",
  children,
}: {
  open: boolean;
  /** The element the panel positions against (usually the picker's root). */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Which edge to align with the anchor's matching edge. Default "right". */
  align?: "left" | "right";
  /** Box styling for the panel (width, border, bg, padding, shadow…). */
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  // Measure + place (with vertical flip) on open, then keep it pinned to the
  // anchor as the page scrolls or resizes. The panel's height is unknown on the
  // first synchronous pass (it hasn't rendered yet), so a rAF second pass re-runs
  // once it has measured — that's when the flip decision becomes accurate.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      if (!a) return;
      const panelH = panelRef.current?.offsetHeight ?? 0;
      const flip = a.bottom + GAP + panelH > window.innerHeight && a.top - GAP - panelH > 0;
      const top = flip ? a.top - GAP - panelH : a.bottom + GAP;
      setPos(
        align === "right"
          ? { top, right: window.innerWidth - a.right }
          : { top, left: a.left },
      );
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorRef, align]);

  // Outside-click closes; clicks on the anchor or inside the panel don't.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, anchorRef, onClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      // The card is HTML5-draggable and the canvas pans on pointerdown; stop both
      // from starting when interacting with the panel (harmless now that it's
      // portaled out of the canvas, but keeps intent clear). The click stop
      // matters because the panel is portaled: React clicks bubble along the
      // component tree, so without it a click inside would reach the parent
      // card's onClick and open the detail modal.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        top: pos?.top ?? -9999,
        left: pos?.left,
        right: pos?.right,
        // Hidden for the one frame before the first measurement lands.
        visibility: pos ? "visible" : "hidden",
        zIndex: 50,
      }}
      className={className}
    >
      {children}
    </div>,
    document.body,
  );
}
