"use client";

/**
 * A team-whiteboard sticky note (TD-55). Unlike everything else on the
 * canvas, this is NOT Liveblocks storage — it's a Postgres `task_notes` row
 * (a `canvasId` + `x`/`y`) surfaced through WorkspaceContext and kept live via
 * the `canvas-notes-changed` room event (see CanvasEditor's broadcast
 * bridge). Position is committed once on pointerup rather than live-streamed
 * like a Liveblocks node drag — a sticky move is low-frequency and
 * single-editor-at-a-time, so there's nothing to glide for peers to see.
 *
 * Resolving (the review checkbox) dims it in place rather than removing it —
 * same convention as the Notes page and the task modal's review notes — so a
 * checked-off sticky stays as a visible "handled" marker until someone
 * deletes it with the "×".
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Markdown } from "@/components/ui/Markdown";
import type { Note, NoteType } from "@/lib/types";

export const STICKY_WIDTH = 200;

const TINT: Record<NoteType, string> = {
  review: "bg-nerf-soft border-nerf/30",
  decision: "bg-accent-soft border-accent/30",
  blocker: "bg-nerf-soft border-nerf/30",
  progress: "bg-buff-soft border-buff/30",
  milestone: "bg-buff-soft border-buff/30",
  question: "bg-accent-soft border-accent/30",
  fyi: "bg-surface border-border",
};

export function CanvasStickyNote({
  note,
  scale,
  onMove,
  onResolve,
  onDelete,
}: {
  note: Note;
  scale: number;
  onMove: (x: number, y: number) => void;
  onResolve: (resolved: boolean) => void;
  onDelete: () => void;
}) {
  // Live-drag position, local only — the parent's `note.x/y` updates once
  // `onMove` commits (optimistically, then via PATCH), at which point this
  // clears and the two agree again.
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const dragStart = useRef<{
    clientX: number;
    clientY: number;
    x: number;
    y: number;
  } | null>(null);

  const resolved = Boolean(note.resolvedAt);
  const x = drag?.x ?? note.x ?? 0;
  const y = drag?.y ?? note.y ?? 0;

  function onPointerDown(e: ReactPointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragStart.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      x: note.x ?? 0,
      y: note.y ?? 0,
    };
    const onMoveEv = (ev: PointerEvent) => {
      const start = dragStart.current;
      if (!start) return;
      const dx = (ev.clientX - start.clientX) / scale;
      const dy = (ev.clientY - start.clientY) / scale;
      setDrag({ x: Math.round(start.x + dx), y: Math.round(start.y + dy) });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMoveEv);
      window.removeEventListener("pointerup", onUp);
      const start = dragStart.current;
      dragStart.current = null;
      setDrag((cur) => {
        if (cur && start && (cur.x !== start.x || cur.y !== start.y)) onMove(cur.x, cur.y);
        return null;
      });
    };
    window.addEventListener("pointermove", onMoveEv);
    window.addEventListener("pointerup", onUp);
  }

  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: STICKY_WIDTH,
        transition: drag ? undefined : "left 90ms linear, top 90ms linear",
      }}
      className={[
        "group/sticky relative select-none rounded-lg border p-2.5 pr-6 text-sm shadow-sm",
        "cursor-grab active:cursor-grabbing",
        TINT[(note.type ?? "fyi") as NoteType],
        resolved ? "opacity-45" : "",
      ].join(" ")}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        title="Delete note"
        className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded text-faint hover:bg-black/10 hover:text-fg group-hover/sticky:flex"
      >
        ×
      </button>
      <div className="flex items-start gap-1.5">
        <input
          type="checkbox"
          checked={resolved}
          onChange={(e) => onResolve(e.target.checked)}
          onPointerDown={(e) => e.stopPropagation()}
          className="mt-0.5 shrink-0 cursor-pointer accent-accent"
          aria-label={resolved ? "Re-open" : "Mark reviewed"}
        />
        <Markdown className={resolved ? "line-through" : ""}>{note.note}</Markdown>
      </div>
    </div>
  );
}
