"use client";

/**
 * A `section_group` node — a movable container that stacks its member sections
 * in a vertical column under a big title. Purely presentational: it stores only
 * its own name (`content`) and anchor (`x/y`); membership lives on the children
 * (each member section carries `data.groupId === this.id`), and the column
 * layout — each member's position plus this box's derived `width/height` — is
 * computed and mirrored back in CanvasEditor. The header doubles as the drag
 * handle (moving the group re-derives the whole column, so members follow).
 */

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { CanvasNode as CanvasNodeT } from "@/lib/types";

/** Title-band height (canvas units). Kept in sync with the layout math in
 *  CanvasEditor via the shared constants below. */
export const GROUP_HEADER_H = 56;
/** Inner padding around the member column. */
export const GROUP_PAD = 16;
/** Vertical gap between stacked members. */
export const GROUP_GAP = 16;
/** Size of a freshly-dropped (empty) group — a visible drop target. */
export const NEW_GROUP_SIZE = { width: 460, height: 220 };

export function SectionGroupNode({
  node,
  selected,
  smooth,
  editing,
  memberCount,
  dropActive,
  onPointerDown,
  onStartEditing,
  onChange,
  onStopEditing,
  onRemove,
}: {
  node: CanvasNodeT;
  selected: boolean;
  smooth: boolean;
  editing: boolean;
  /** How many sections currently belong to this group (drives the empty hint). */
  memberCount: number;
  /** A section is being dragged over this group right now — highlight it. */
  dropActive: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onStartEditing: () => void;
  onChange: (content: string) => void;
  onStopEditing: () => void;
  onRemove?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select the name when entering edit mode, so a fresh group (or a
  // re-edit) lets you type the name straight away.
  useEffect(() => {
    if (!editing) return;
    const focus = () => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    };
    focus();
    const raf = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(raf);
  }, [editing]);

  const title = node.content.trim();

  return (
    <div
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        // Glide to new positions when the move came from someone else.
        transition: smooth ? "left 90ms linear, top 90ms linear" : undefined,
      }}
      className={[
        "flex flex-col rounded-xl border-2 bg-surface-2/60 shadow-sm",
        dropActive
          ? "border-accent ring-2 ring-accent"
          : selected
            ? "border-accent"
            : "border-border-strong",
      ].join(" ")}
    >
      {/* Header = big name in a text-field-styled band; also the drag handle. */}
      <div
        onPointerDown={onPointerDown}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onStartEditing();
        }}
        style={{ height: GROUP_HEADER_H }}
        className="group/gh flex shrink-0 cursor-grab items-center gap-2 rounded-t-[10px] border-b border-border bg-surface px-4 active:cursor-grabbing"
      >
        {editing ? (
          <input
            ref={inputRef}
            value={node.content}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onStopEditing}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") {
                e.preventDefault();
                onStopEditing();
              }
            }}
            placeholder="Group name…"
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-2xl font-bold text-fg outline-none focus:border-accent"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-2xl font-bold text-fg">
            {title || <span className="text-faint">Untitled group</span>}
          </span>
        )}
        {onRemove ? (
          <button
            type="button"
            title="Delete group (its sections are kept)"
            aria-label="Delete group"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-xs font-medium text-faint opacity-0 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600 group-hover/gh:opacity-100"
          >
            ✕
          </button>
        ) : null}
      </div>

      {/* Body: a transparent drop zone. Member sections are separate nodes that
          render on top (the editor positions them into this column), so this is
          only the backdrop + empty-state hint. */}
      <div className="pointer-events-none flex flex-1 items-center justify-center">
        {memberCount === 0 ? (
          <span className="text-sm text-faint">Drag sections here</span>
        ) : null}
      </div>
    </div>
  );
}
