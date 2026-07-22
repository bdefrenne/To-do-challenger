"use client";

/**
 * One freehand pen stroke on the canvas — a `draw` node.
 *
 * A stroke is just the raw path the cursor traced while drawing (sampled
 * points), rendered as a single SVG `<path>`, lightly smoothed so it doesn't
 * look jagged. There are NO editable anchor points or bézier handles — it's a
 * pencil, not a vector Pen tool.
 *
 * Points live in `node.data.points` as a flat `[x0,y0,x1,y1,…]` list *relative*
 * to the node's top-left, so moving the stroke only patches `node.x/y` and the
 * generic drag code in CanvasEditor works unchanged. Stroke color reuses
 * `node.color`; width rides in `node.data.strokeWidth` (canvas units, so it
 * scales with zoom like everything else).
 *
 * The SVG itself is `pointer-events: none` so the mostly-transparent bounding
 * box never blocks nodes underneath; a fat transparent hit-path (the same trick
 * the connector unlink lines use in CanvasEditor) makes only the *ink* a hit
 * target for the eraser. Strokes are NOT selectable or draggable — clicking one
 * bubbles through to the canvas so you can keep drawing over it.
 */

import type { PointerEvent as ReactPointerEvent } from "react";
import type { CanvasNode as CanvasNodeT } from "@/lib/types";

/** Default pen — a near-black ink at a comfortable medium weight. */
export const DEFAULT_PEN_COLOR = "#111827";
export const DEFAULT_PEN_WIDTH = 3;

/** Read a stroke's points / width from its free-form `data` bag. */
export const strokePoints = (n: { data?: Record<string, unknown> }): number[] =>
  (n.data?.points as number[] | undefined) ?? [];
export const strokeWidthOf = (n: { data?: Record<string, unknown> }): number =>
  (n.data?.strokeWidth as number | undefined) ?? DEFAULT_PEN_WIDTH;

/** Build a smoothed SVG path `d` from a flat `[x0,y0,x1,y1,…]` point list.
 *  Draws quadratic segments through the midpoints of consecutive samples so a
 *  hand-drawn polyline reads as one rounded stroke. This is purely internal
 *  smoothing of the captured samples — there are no user-facing control
 *  points. Returns "" for 0–1 points (the caller renders a dot instead). */
export function strokePath(points: number[]): string {
  const n = points.length >> 1;
  if (n < 2) return "";
  const px = (i: number) => points[i * 2];
  const py = (i: number) => points[i * 2 + 1];
  let d = `M ${px(0)} ${py(0)}`;
  if (n === 2) return `${d} L ${px(1)} ${py(1)}`;
  for (let i = 1; i < n - 1; i++) {
    const mx = (px(i) + px(i + 1)) / 2;
    const my = (py(i) + py(i + 1)) / 2;
    d += ` Q ${px(i)} ${py(i)} ${mx} ${my}`;
  }
  return `${d} L ${px(n - 1)} ${py(n - 1)}`;
}

export function DrawNode({
  node,
  selected,
  smooth = true,
  onPointerDown,
}: {
  node: CanvasNodeT;
  selected: boolean;
  /** Ease position changes for remote moves (off while YOU drag it). */
  smooth?: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
}) {
  const points = strokePoints(node);
  const width = strokeWidthOf(node);
  const color = node.color ?? DEFAULT_PEN_COLOR;
  const d = strokePath(points);
  const isDot = points.length < 4; // 0 or 1 sampled point → a dot
  const dotX = points[0] ?? node.width / 2;
  const dotY = points[1] ?? node.height / 2;
  // Fat, invisible hit target so clicks land on the ink, not the empty bbox.
  const hitWidth = Math.max(width + 8, 14);

  return (
    <svg
      className="pointer-events-none absolute overflow-visible"
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        transition: smooth ? "left 90ms linear, top 90ms linear" : undefined,
      }}
      width={node.width}
      height={node.height}
    >
      {selected ? (
        <rect
          x={0}
          y={0}
          width={node.width}
          height={node.height}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
      ) : null}

      {isDot ? (
        <>
          <circle cx={dotX} cy={dotY} r={width / 2} fill={color} />
          <circle
            cx={dotX}
            cy={dotY}
            r={hitWidth / 2}
            fill="transparent"
            data-draw-id={node.id}
            className="pointer-events-auto"
            onPointerDown={onPointerDown}
          />
        </>
      ) : (
        <>
          <path
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={width}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Transparent hit path — grabs/erases land on the ink only. */}
          <path
            d={d}
            fill="none"
            stroke="transparent"
            strokeWidth={hitWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            data-draw-id={node.id}
            className="pointer-events-auto"
            onPointerDown={onPointerDown}
          />
        </>
      )}
    </svg>
  );
}
