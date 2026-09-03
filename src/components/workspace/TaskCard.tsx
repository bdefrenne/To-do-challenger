"use client";

import { GripVertical } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import type { Task } from "@/lib/types";
import { TaskCardBody, type TaskCardHandlers } from "./TaskCardBody";
import { useWorkspace } from "./WorkspaceContext";
import { useTaskCardShortcuts } from "./useTaskCardShortcuts";
import { useDragSessionEnd } from "./useDragSessionEnd";
import { IMPORTANCE_CARD } from "@/lib/importance";
import { STATUS_CANVAS_BADGE, STATUS_TONE } from "@/lib/statuses";

/** Mime used to carry the dragged task id across kanban columns/boards. */
export const TASK_DND_MIME = "text/plain";

/**
 * A draggable kanban card. Renders the SAME body as the canvas Section card
 * (<TaskCardBody/> — title, description, assignees, hover S/I/A pickers) inside
 * a kanban-flavored container: click opens the modal, drag onto another column
 * (same or different board) moves it, and the hovered card takes the same
 * keyboard set as on canvas (`useTaskCardShortcuts`).
 */
export function TaskCard({
  task,
  onOpen,
  statusBadge = false,
  neutralDone = false,
  readOnly = false,
  onDropAt,
  dimmed = false,
  children,
}: {
  task: Task;
  onOpen: () => void;
  /** Draw the canvas card's status ring + corner badge (started statuses only).
   *  On by default nowhere — the kanban columns ARE status columns, so a badge
   *  repeating the column header is noise; the Boards view, whose columns mix
   *  statuses, turns it on. */
  statusBadge?: boolean;
  /** Drop the green done wash and keep the importance colors instead. The Done
   *  view sets it: on a page where everything is done, green carries no
   *  information and costs the readability the importance colors give back. */
  neutralDone?: boolean;
  /** A read-only log of finished work (the Done view): the card isn't draggable
   *  and its DELETE / triage-arrow keys are off, since there's nowhere here to
   *  drop it and nothing here to re-file. The pickers and D still work. */
  readOnly?: boolean;
  /** Accept a dropped card ABOVE or BELOW this one, so a view can offer exact
   *  placement rather than only "append to this column". Omitted (the kanban
   *  page, the Done view) leaves the card drop-inert exactly as before: the
   *  column underneath keeps the whole gesture. */
  onDropAt?: (dragId: string, pos: "before" | "after") => void;
  /** Drawn only as CONTEXT for a matching subtask under an assignee filter
   *  (TD2-216) — nothing on this card is theirs. Dimmed, exactly as the canvas
   *  card is, so the real match still reads as the point of the filter. */
  dimmed?: boolean;
  /** Nested subtask cards, rendered indented beneath this one. */
  children?: React.ReactNode;
}) {
  const { setStatus, editTask } = useWorkspace();
  const [dragging, setDragging] = useState(false);
  // Which edge a hovered drop would land on — the accent line the user aims by.
  const [dropPos, setDropPos] = useState<"before" | "after" | null>(null);
  // The line goes out when the drag ends, however it ends — the card's own
  // handlers miss an Escape-cancelled drag. See `useDragSessionEnd`.
  useDragSessionEnd(dropPos !== null, () => setDropPos(null));
  const cardRef = useRef<HTMLDivElement>(null);
  const id = task.id;
  const done = task.status === "done";
  const c = IMPORTANCE_CARD[task.importance ?? 0];

  // The full canvas hover set — D · 1/2 · SPACE · DELETE · ↑→↓ — from the one
  // shared definition, so this card and the canvas Section card can't drift.
  useTaskCardShortcuts(cardRef, id, { triage: !readOnly });

  const h: TaskCardHandlers = {
    onOpen: () => onOpen(),
    onStatus: (tid, s) => setStatus(tid, s),
    onImportance: (tid, v) => editTask(tid, { importance: v }),
    onAssign: (tid, patch) => editTask(tid, patch),
  };

  // Status ring + corner badge, identical to the canvas Section card: only the
  // "started" statuses are in the map, so backlog/todo/done draw neither (done
  // keeps its green wash instead).
  const badge = statusBadge ? STATUS_CANVAS_BADGE[task.status] : undefined;
  const statusTone = STATUS_TONE[task.status];

  /* ---- exact placement (only where the view asked for it) ----
   * Two zones, no middle: dropping a card ON a card here means "put it here",
   * never "nest it under this one" — nesting stays a List/Canvas gesture, and a
   * third zone would make the common case (place it) a 40%-of-the-card target.
   * Every handler stops propagation, or the column beneath would also claim the
   * drop and append the card instead. */
  const hasTaskPayload = (e: DragEvent<HTMLDivElement>) =>
    e.dataTransfer.types.includes(TASK_DND_MIME);
  const zoneFromEvent = (e: DragEvent<HTMLDivElement>): "before" | "after" => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY - r.top < r.height / 2 ? "before" : "after";
  };

  return (
    <>
      <div
        ref={cardRef}
        data-card
        data-task-id={id}
        draggable={!readOnly}
        onDragStart={(e) => {
          if (readOnly) return;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(TASK_DND_MIME, id);
          setDragging(true);
        }}
        onDragEnd={() => setDragging(false)}
        onDragOver={
          onDropAt
            ? (e) => {
                if (!hasTaskPayload(e)) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                setDropPos(zoneFromEvent(e));
              }
            : undefined
        }
        onDragLeave={
          onDropAt
            ? (e) => {
                // Only when the pointer really leaves the card: dragging across
                // a control inside it fires dragleave on the way past, and
                // reacting to that makes the line flicker.
                if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                  setDropPos(null);
              }
            : undefined
        }
        onDrop={
          onDropAt
            ? (e) => {
                if (!hasTaskPayload(e)) return;
                e.preventDefault();
                e.stopPropagation();
                const pos = zoneFromEvent(e);
                setDropPos(null);
                const dropped = e.dataTransfer.getData(TASK_DND_MIME);
                if (dropped && dropped !== id) onDropAt(dropped, pos);
              }
            : undefined
        }
        onClick={onOpen}
        className={[
          "group/card relative cursor-pointer rounded-lg border px-2 py-1.5 transition-colors",
          done && !neutralDone
            ? "border-buff/40 bg-buff-soft hover:border-buff/60"
            : `${c.border} ${c.bg} ${c.hover}`,
          // Outline rather than ring, matching the canvas card — it follows the
          // rounded corners without clashing with any drop-hint shadow.
          badge ? `outline outline-[3px] outline-offset-2 ${statusTone.outline}` : "",
          dragging ? "opacity-40" : "",
          dimmed ? "opacity-45" : "",
          // Same drop hint as the List view's rows, so the gesture reads the
          // same on both surfaces.
          dropPos === "before" ? "shadow-[inset_0_2px_0_0_var(--color-accent)]" : "",
          dropPos === "after" ? "shadow-[inset_0_-2px_0_0_var(--color-accent)]" : "",
        ].join(" ")}
      >
        {badge ? (
          <span
            className={`absolute -top-2 right-2 z-10 rounded px-1.5 py-0.5 text-[10px] font-semibold text-white ${statusTone.dot}`}
          >
            {badge}
          </span>
        ) : null}
        <div className="flex min-w-0 items-start gap-1.5">
          {/* The gesture, offered rather than guessed at — dragging a card was
              invisible until you tried it. Hover-only and drag-inert itself (the
              whole card is the drag source), matching the List view's handle. */}
          {!readOnly ? (
            <span
              aria-hidden
              title="Drag to move or reorder"
              className="mt-0.5 shrink-0 cursor-grab text-faint opacity-0 transition-opacity group-hover/card:opacity-100"
            >
              <GripVertical aria-hidden size={13} strokeWidth={1.75} />
            </span>
          ) : null}
          <TaskCardBody task={task} h={h} neutralDone={neutralDone} />
        </div>
      </div>
      {children ? <div className="ml-3 mt-1.5 space-y-1.5">{children}</div> : null}
    </>
  );
}
