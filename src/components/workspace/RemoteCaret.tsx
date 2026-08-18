"use client";

import { useLayoutEffect, useRef, useState } from "react";

/** Typography that decides where a character lands. Copied from the real
 *  textarea onto the mirror; miss one and the caret drifts along the line. */
const MIRRORED = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderLeftWidth",
  "wordSpacing",
  "tabSize",
] as const;

type Measured = { left: number; top: number; height: number };

/**
 * A peer's text caret, drawn inside one outline row.
 *
 * **Why a mirror.** A `<textarea>` has no DOM for its own text, so there is no
 * node to measure — `Range.getClientRects()` only works in `contenteditable`, and
 * switching the outline to contenteditable would throw away the entire keyboard
 * model in `onRowKeyDown`. So we render an invisible div that wraps text exactly
 * like the textarea does, put the peer's text up to their offset in it, and read
 * the position of a zero-width marker at the end. Line wrapping comes free
 * because the mirror wraps identically.
 *
 * Mount this only for rows that actually hold a remote caret — at most one per
 * peer, never one per row.
 */
export function RemoteCaret({
  target,
  text,
  offset,
  color,
  name,
}: {
  /** The row's textarea. The mirror copies its box and typography. */
  target: HTMLTextAreaElement | HTMLInputElement | null;
  /** OUR copy of the row's text. One RTT behind the peer's keystroke, which is
   *  why `offset` is clamped to it rather than trusted. */
  text: string;
  offset: number;
  color: string;
  name: string;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const [style, setStyle] = useState<React.CSSProperties | null>(null);
  const [at, setAt] = useState<Measured | null>(null);

  // Copy the textarea's typography onto the mirror, and re-copy when the row
  // resizes (a wrapped line changes height, the section can be resized).
  useLayoutEffect(() => {
    if (!target) return;
    const read = () => {
      const cs = getComputedStyle(target);
      const next: Record<string, string> = {};
      for (const k of MIRRORED) next[k] = cs[k];
      // The width has to match to the pixel or the mirror wraps somewhere else.
      next.width = `${target.clientWidth}px`;
      setStyle(next as React.CSSProperties);
    };
    read();
    // A ResizeObserver fires on BORDER-box changes, and the case that matters here
    // isn't one: a capped description row growing past its 6-row limit gains a
    // scrollbar, which shrinks `clientWidth` while the border box stays put. Miss
    // that and the mirror keeps wrapping at the old width — the caret drifts on
    // every wrapped line. So re-read on the row's own scroll/overflow changes too.
    const ro = new ResizeObserver(read);
    ro.observe(target);
    target.addEventListener("scroll", read);
    return () => {
      ro.disconnect();
      target.removeEventListener("scroll", read);
    };
    // `text` is a dep because its LENGTH is what makes the scrollbar appear.
  }, [target, text]);

  // Measure after every paint that could have moved the marker.
  useLayoutEffect(() => {
    const marker = markerRef.current;
    const mirror = mirrorRef.current;
    if (!marker || !mirror || !target || !style) return;
    const lh = parseFloat(getComputedStyle(mirror).lineHeight);
    setAt({
      left: marker.offsetLeft,
      // A capped description row scrolls; the caret has to scroll with it.
      top: marker.offsetTop - target.scrollTop,
      height: Number.isFinite(lh) && lh > 0 ? lh : target.clientHeight,
    });
  }, [text, offset, style, target]);

  if (!style) return null;
  // Their offset can exceed our copy of the text for one round-trip; clamping
  // keeps the caret at the end of what we have instead of jumping to 0.
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));

  return (
    <>
      <div
        ref={mirrorRef}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 overflow-hidden"
        style={{
          ...style,
          visibility: "hidden",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {before}
        <span ref={markerRef}>{"​"}</span>
      </div>
      {at ? (
        <span
          className="pointer-events-none absolute z-10"
          style={{ left: at.left, top: at.top, height: at.height }}
        >
          {/* No blink: a blinking remote caret reads as your own. */}
          <span
            className="absolute inset-y-0 left-0 w-0.5 rounded-full"
            style={{ background: color }}
          />
          {/* The flag is loud, so it fades once they stop moving. Keyed on the
              offset so each keystroke REMOUNTS it and restarts the animation —
              cheaper (and lint-clean) than driving a timer through state. */}
          <span
            key={`${offset}:${text.length}`}
            className="animate-caret-flag absolute -top-4 left-0 whitespace-nowrap rounded px-1 py-px text-[10px] font-medium text-white"
            style={{ background: color }}
          >
            {name}
          </span>
        </span>
      ) : null}
    </>
  );
}
