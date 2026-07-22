"use client";

import { useRef, useState, type DragEvent } from "react";
import type { Task, TaskStatus, Importance } from "@/lib/types";
import type { DropPos, TaskNode } from "./WorkspaceContext";
import { BoardPill, type BoardGroup } from "./BoardPill";
import { QuickStatus } from "./QuickStatus";
import { QuickImportance } from "./QuickImportance";
import { QuickAssign } from "./QuickAssign";
import { useCardShortcut } from "./useCardShortcut";
import { formatRelative, formatDue } from "@/lib/format";
import { IMPORTANCE_CARD } from "@/lib/importance";

/** Shared grid template so header and rows line up. */
export const GRID =
  "grid grid-cols-[minmax(240px,1fr)_64px_140px_150px_104px_92px] items-center";

/**
 * One draggable table row. Click the name to open the task; drag onto the
 * top/bottom third of another row to reorder, or onto the middle to nest it.
 */
export function TaskTableRow({
  node,
  task,
  depth,
  hasChildren,
  expanded,
  draggingId,
  currentBoardId,
  currentBoardName,
  boardColor,
  boardGroups,
  onChangeBoard,
  onToggleExpand,
  onOpen,
  onToggleDone,
  onSetStatus,
  onImportance,
  onAssign,
  onAssignSelf,
  onDelete,
  memberIds,
  onEditMembers,
  onDragStartRow,
  onDropRow,
}: {
  node: TaskNode;
  task: Task;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  draggingId: string | null;
  /** The task's current board id, or null when unassigned. */
  currentBoardId: string | null;
  /** Resolved current board name; null → the pill shows "No board". */
  currentBoardName: string | null;
  /** Resolved board accent color (board's own, or its project's fallback). */
  boardColor?: string | null;
  /** Boards the task may move to, grouped by project (see BoardPill). */
  boardGroups: BoardGroup[];
  /** Move the task onto another board. */
  onChangeBoard: (boardId: string) => void;
  onToggleExpand: () => void;
  onOpen: () => void;
  onToggleDone: () => void;
  onSetStatus: (s: TaskStatus) => void;
  onImportance: (v: Importance) => void;
  /** Assignee change from QuickAssign (`(id, { assigneeIds })`). */
  onAssign: (id: string, patch: { assigneeIds: string[] }) => void;
  /** SPACE — toggle the viewer as an assignee. */
  onAssignSelf: () => void;
  /** DELETE / Backspace — delete the task. */
  onDelete: () => void;
  /** Project members to scope the assign picker to (see QuickAssign). */
  memberIds?: string[];
  /** Opens the task's project members editor from the assign picker footer. */
  onEditMembers?: () => void;
  onDragStartRow: (id: string) => void;
  onDropRow: (targetId: string, pos: DropPos) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<DropPos | null>(null);
  const done = node.status === "done";
  const isDragging = draggingId === node.id;
  const importance = task.importance ?? 0;
  const ic = IMPORTANCE_CARD[importance];
  const due = task.dueDate ? formatDue(task.dueDate) : null;

  // Hover-scoped per-task shortcuts, matching the canvas Section / kanban cards
  // (see SectionNode's TaskCard). S / I / A are self-registered by the Quick*
  // pickers below; these are the direct-action keys.
  //  "D" — not-done → done (via the checkbox's complete path), done → building.
  useCardShortcut(cardRef, "d", () => (done ? onSetStatus("building") : onToggleDone()));
  //  "1" / "2" — set importance directly (Elevated / High).
  useCardShortcut(cardRef, "1", () => onImportance(1));
  useCardShortcut(cardRef, "2", () => onImportance(2));
  //  SPACE — toggle the viewer as an assignee.
  useCardShortcut(cardRef, " ", onAssignSelf);
  //  DELETE / Backspace — delete the task (with the workspace's undo window).
  useCardShortcut(cardRef, "delete", onDelete);
  useCardShortcut(cardRef, "backspace", onDelete);

  function zoneFromEvent(e: DragEvent<HTMLDivElement>): DropPos {
    const r = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - r.top;
    if (y < r.height * 0.3) return "before";
    if (y > r.height * 0.7) return "after";
    return "inside";
  }

  return (
    <div
      ref={cardRef}
      data-card
      data-task-id={node.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStartRow(node.id);
      }}
      onDragOver={(e) => {
        if (!draggingId || draggingId === node.id) return;
        e.preventDefault();
        setPos(zoneFromEvent(e));
      }}
      onDragLeave={() => setPos(null)}
      onDrop={(e) => {
        e.preventDefault();
        const p = zoneFromEvent(e);
        setPos(null);
        onDropRow(node.id, p);
      }}
      className={[
        GRID,
        "group/card group relative border-b border-border px-3 py-2 text-sm transition-colors",
        // Importance tint — background only here (the row border stays neutral),
        // warm→cold. Normal stays plain.
        importance !== 0 ? ic.bg : "hover:bg-surface-2",
        isDragging ? "opacity-40" : "",
        pos === "inside" ? "ring-1 ring-inset ring-accent" : "",
        pos === "before" ? "shadow-[inset_0_2px_0_0_var(--color-accent)]" : "",
        pos === "after" ? "shadow-[inset_0_-2px_0_0_var(--color-accent)]" : "",
      ].join(" ")}
    >
      {/* Name cell */}
      <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 20 }}>
        <span
          className="cursor-grab text-faint opacity-0 transition-opacity group-hover:opacity-100"
          title="Drag to reorder or nest"
          aria-hidden
        >
          ⠿
        </span>
        {hasChildren ? (
          <button
            onClick={onToggleExpand}
            className="w-3 shrink-0 text-faint hover:text-fg"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}

        <button
          onClick={onToggleDone}
          aria-label={done ? "Mark not done" : "Mark done"}
          className={[
            "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border text-[10px] transition-colors",
            done
              ? "border-buff bg-buff text-white"
              : "border-border-strong text-transparent hover:border-buff hover:text-buff",
          ].join(" ")}
        >
          ✓
        </button>

        <button onClick={onOpen} className="flex min-w-0 items-center gap-2 text-left">
          <span className={`truncate ${done ? "text-faint line-through" : "text-fg"}`}>
            {task.title}
          </span>
          {task.commentCount ? (
            <span className="shrink-0 text-xs text-faint" title={`${task.commentCount} comments`}>
              💬 {task.commentCount}
            </span>
          ) : null}
        </button>

        {/* Importance — click or "I" opens the picker; "1"/"2" set it directly. */}
        <QuickImportance
          importance={importance}
          onChange={onImportance}
          revealOnHover={false}
        />
      </div>

      {/* Assignees — click or "A" opens the picker; SPACE assigns the viewer. */}
      <div className="flex justify-center" onClick={(e) => e.stopPropagation()}>
        <QuickAssign
          taskId={node.id}
          assigneeIds={task.assigneeIds ?? []}
          onChange={onAssign}
          memberIds={memberIds}
          onEditMembers={onEditMembers}
          revealOnHover={false}
        />
      </div>

      {/* Board picker */}
      <div onClick={(e) => e.stopPropagation()}>
        <BoardPill
          currentBoardId={currentBoardId}
          currentBoardName={currentBoardName}
          color={boardColor}
          groups={boardGroups}
          onChange={onChangeBoard}
        />
      </div>

      {/* Status — click or "S" opens the picker. */}
      <div onClick={(e) => e.stopPropagation()}>
        <QuickStatus status={node.status} onChange={onSetStatus} revealOnHover={false} />
      </div>

      {/* Due date */}
      <div className="text-xs">
        {due ? (
          <span
            className={
              done
                ? "text-faint"
                : due.overdue
                  ? "font-medium text-nerf"
                  : due.today
                    ? "font-medium text-accent"
                    : "text-muted"
            }
          >
            {due.label}
          </span>
        ) : (
          <span className="text-faint">—</span>
        )}
      </div>

      {/* Updated */}
      <div className="text-xs text-faint">
        {task.updatedAt ? formatRelative(task.updatedAt) : "—"}
      </div>
    </div>
  );
}
