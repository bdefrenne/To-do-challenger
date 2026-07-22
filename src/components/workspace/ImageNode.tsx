"use client";

/**
 * One image on the canvas — an `image` node. A pasted or dropped picture whose
 * public blob URL lives in `node.data.url`; `node.data.naturalW/naturalH` carry
 * the source pixel size so resizing stays aspect-locked.
 *
 * Purely presentational, like the other node views: the editor supplies
 * `onPointerDown` (which drives select + move via the generic node-drag code).
 * The only extra behaviour here is a corner resize handle, shown when selected,
 * that scales the box while preserving the image's aspect ratio.
 */

import { type PointerEvent as ReactPointerEvent } from "react";
import type { CanvasNode as CanvasNodeT } from "@/lib/types";

/** Read the blob URL off the node's free-form `data` bag. */
export const imageUrlOf = (n: { data?: Record<string, unknown> }): string =>
  (n.data?.url as string | undefined) ?? "";

/** Smallest a resized image box may get (canvas units). */
const MIN_SIZE = 32;

export function ImageNode({
  node,
  selected,
  smooth = true,
  scale,
  onPointerDown,
  onResize,
  onResizeStart,
  onResizeEnd,
}: {
  node: CanvasNodeT;
  selected: boolean;
  /** Ease position changes for remote moves (off while YOU drag it). */
  smooth?: boolean;
  /** Current viewport zoom — converts a screen-space drag to canvas units. */
  scale: number;
  onPointerDown: (e: ReactPointerEvent) => void;
  /** Commit a new box size (aspect already applied). */
  onResize: (width: number, height: number) => void;
  /** Group the whole resize drag into one undo step. */
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}) {
  const url = imageUrlOf(node);
  // Aspect from the source pixels when known, else the current box.
  const natW = (node.data?.naturalW as number | undefined) ?? node.width;
  const natH = (node.data?.naturalH as number | undefined) ?? node.height;
  const aspect = natW > 0 && natH > 0 ? natW / natH : node.width / node.height || 1;

  const startResize = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startW = node.width;
    // Zoom doesn't change during a handle drag, so capturing scale here is safe.
    const s = scale || 1;
    let began = false;
    const onMove = (ev: PointerEvent) => {
      if (!began) {
        began = true;
        onResizeStart?.();
      }
      const w = Math.max(MIN_SIZE, Math.round(startW + (ev.clientX - startX) / s));
      const h = Math.max(MIN_SIZE, Math.round(w / aspect));
      onResize(w, h);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (began) onResizeEnd?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      className={[
        "group/image absolute overflow-hidden rounded-lg border shadow-sm",
        selected ? "border-accent ring-1 ring-accent" : "border-border",
        "cursor-grab active:cursor-grabbing",
      ].join(" ")}
      style={{
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        transition: smooth ? "left 90ms linear, top 90ms linear" : undefined,
      }}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={node.content || "Pasted image"}
          draggable={false}
          className="pointer-events-none h-full w-full select-none object-contain"
        />
      ) : (
        <div className="grid h-full w-full place-items-center bg-surface-2 text-xs text-faint">
          Uploading…
        </div>
      )}

      {/* Aspect-locked resize handle (bottom-right), only when selected. */}
      {selected ? (
        <button
          type="button"
          aria-label="Resize image"
          title="Drag to resize"
          onPointerDown={startResize}
          className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-sm border border-accent bg-surface shadow-sm"
        />
      ) : null}
    </div>
  );
}
