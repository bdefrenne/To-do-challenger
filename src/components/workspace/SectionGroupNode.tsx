"use client";

/**
 * A `section_group` node — a movable container that arranges its member sections
 * under a big title, either **portrait** (stacked in a column, the default) or
 * **landscape** (laid out left-to-right in a row); the header carries an icon to
 * toggle between the two. Purely presentational: it stores only its own name
 * (`content`), anchor (`x/y`) and orientation (`data.layout`); membership lives
 * on the children (each member section carries `data.groupId === this.id`), and
 * the arrangement — each member's position plus this box's derived
 * `width/height` — is computed and mirrored back in CanvasEditor. The header
 * doubles as the drag handle (moving the group re-derives the whole layout, so
 * members follow).
 */

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { CanvasNode as CanvasNodeT } from "@/lib/types";
import { systemGroupOf, type SystemGroup } from "@/lib/sections";

/** How a group arranges its members: a vertical column ("portrait", the
 *  default) or a horizontal row ("landscape" / paysage). */
export type GroupLayout = "portrait" | "landscape";

/** A group's orientation, read off `data.layout` (absent ⇒ portrait, which is
 *  how every group behaved before the toggle existed). */
export const groupLayoutOf = (node: CanvasNodeT): GroupLayout =>
  node.data?.layout === "landscape" ? "landscape" : "portrait";

/** Title-band height (canvas units). Kept in sync with the layout math in
 *  CanvasEditor via the shared constants below. */
export const GROUP_HEADER_H = 56;
/** Inner padding around the member column/row. */
export const GROUP_PAD = 16;
/** Gap between adjacent members (down the column, or across the row). */
export const GROUP_GAP = 16;
/** Size of a freshly-dropped (empty) group — a visible drop target. */
export const NEW_GROUP_SIZE = { width: 460, height: 220 };

/** What an empty machine-managed tray says about itself. Each names how cards
 *  GET here, since you never build one by hand. */
const EMPTY_TRAY_HINT: Record<SystemGroup, string> = {
  inbox: "Nothing untriaged",
  today: "Nothing on today's list — drop a card here, or file it from a board",
  thisWeek: "Nothing on this week's board — hover a card and press ↑",
  backlog: "Nothing in the backlog — hover a card and press →",
  later: "Nothing deferred — hover a card and press ↓",
  doneThisWeek: "Nothing finished yet — press Delete on a done card, or one in review",
};

/** The toggle's glyph: two stacked bars for portrait (a column), two
 *  side-by-side bars for landscape (a row). Depicts the CURRENT layout — the
 *  tooltip says what clicking it switches to. */
function LayoutGlyph({ layout }: { layout: GroupLayout }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {layout === "portrait" ? (
        <>
          <rect x="1" y="1.5" width="12" height="4.5" rx="1" fill="currentColor" />
          <rect x="1" y="8" width="12" height="4.5" rx="1" fill="currentColor" />
        </>
      ) : (
        <>
          <rect x="1.5" y="1" width="4.5" height="12" rx="1" fill="currentColor" />
          <rect x="8" y="1" width="4.5" height="12" rx="1" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

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
  onToggleLayout,
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
  /** Flip portrait ⇄ landscape; the editor re-derives the arrangement. */
  onToggleLayout?: (layout: GroupLayout) => void;
  /** Mark/unmark this group as THIS WEEK — one per canvas; the editor demotes
   *  any other when this one is marked. */
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const layout = groupLayoutOf(node);
  const landscape = layout === "landscape";
  // Which machine-managed tray this is, if any — THIS WEEK included now that
  // the reconciler owns it too (TD-137), so there is no star left to draw.
  const systemKind = systemGroupOf(node);

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
        {onToggleLayout ? (
          <button
            type="button"
            title={
              landscape
                ? "Landscape — click for portrait (stack sections in a column)"
                : "Portrait — click for landscape (lay sections out in a row)"
            }
            aria-label={landscape ? "Switch to portrait layout" : "Switch to landscape layout"}
            aria-pressed={landscape}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onToggleLayout(landscape ? "portrait" : "landscape");
            }}
            className="shrink-0 rounded-md border border-border px-1.5 py-1 text-faint transition-colors hover:border-accent hover:text-accent"
          >
            <LayoutGlyph layout={layout} />
          </button>
        ) : null}
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

      {/* Body: a transparent backdrop. Member sections are separate nodes that
          render on top (the editor packs them in from the top/left), so once the
          group HAS members there's nothing to draw here — the box wraps them, and
          a drop is captured by the group's own bounds (see `groupAtPoint`), not by
          a visible landing strip. Only an empty group shows a hint. */}
      {memberCount === 0 ? (
        <div className="pointer-events-none flex flex-1 flex-col items-center justify-center p-4">
          <span
            className={[
              "rounded-md border border-dashed px-3 py-2 text-center text-sm transition-colors",
              dropActive ? "border-accent text-accent" : "border-border text-faint",
            ].join(" ")}
          >
            {/* A tray fills itself — its lanes appear per board as cards arrive
                — so telling you to drag sections in would be wrong. */}
            {systemKind ? EMPTY_TRAY_HINT[systemKind] : "Drag sections here"}
          </span>
        </div>
      ) : null}
    </div>
  );
}
