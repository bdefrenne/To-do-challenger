"use client";

import { Check, ChevronDown, ChevronRight, Flag, GripVertical, MessageSquare } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import type { Task, TaskStatus, Importance } from "@/lib/types";
import type { DropPos, TaskNode } from "./WorkspaceContext";
import { AvatarStack } from "@/components/PersonAvatar";
import { BoardPill, type BoardGroup } from "./BoardPill";
import { QuickStatus } from "./QuickStatus";
import { QuickImportance } from "./QuickImportance";
import { QuickAssign } from "./QuickAssign";
import { useTaskCardShortcuts } from "./useTaskCardShortcuts";
import { formatRelative, formatDue } from "@/lib/format";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/statuses";
import { IMPORTANCE_CARD, IMPORTANCE_LABEL, IMPORTANCE_TONE } from "@/lib/importance";

/** Shared grid template so header and rows line up. The board is shown inline
 *  in the Name cell (before the title), so there is no separate Board column. */
export const GRID =
  "grid grid-cols-[minmax(240px,1fr)_64px_150px_104px_92px] items-center";

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
  memberIds,
  onEditMembers,
  onDragStartRow,
  onDropRow,
  dimmed = false,
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
  /** Project members to scope the assign picker to (see QuickAssign). */
  memberIds?: string[];
  /** Opens the task's project members editor from the assign picker footer. */
  onEditMembers?: () => void;
  onDragStartRow: (id: string) => void;
  onDropRow: (targetId: string, pos: DropPos) => void;
  /** Drawn only as CONTEXT for a matching subtask under an assignee filter
   *  (TD2-216) — the row isn't itself assigned to them. Dimmed so the actual
   *  match still reads as the point of the filter, exactly as a canvas card is. */
  dimmed?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<DropPos | null>(null);
  const done = node.status === "done";
  const isDragging = draggingId === node.id;
  const importance = task.importance ?? 0;
  const ic = IMPORTANCE_CARD[importance];
  const due = task.dueDate ? formatDue(task.dueDate) : null;

  // The same hover set as the canvas Section card and the kanban card, from the
  // one shared definition — including the ↑/→/↓ triage arrows, which a row has no
  // band to show but the global send-undo toast makes recoverable. S / I / A are
  // self-registered by the Quick* pickers below.
  useTaskCardShortcuts(cardRef, node.id);

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
        dimmed ? "opacity-45" : "",
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
          <GripVertical aria-hidden size={13} strokeWidth={1.75} />
        </span>
        {hasChildren ? (
          <button
            onClick={onToggleExpand}
            className="w-3 shrink-0 text-faint hover:text-fg"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? (
              <ChevronDown aria-hidden size={13} strokeWidth={2} />
            ) : (
              <ChevronRight aria-hidden size={13} strokeWidth={2} />
            )}
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
          <Check aria-hidden size={12} strokeWidth={3} />
        </button>

        {/* Board — shown inline before the title; click to move (its own menu). */}
        <div onClick={(e) => e.stopPropagation()} className="shrink-0">
          <BoardPill
            currentBoardId={currentBoardId}
            currentBoardName={currentBoardName}
            color={boardColor}
            groups={boardGroups}
            onChange={onChangeBoard}
          />
        </div>

        <button onClick={onOpen} className="flex min-w-0 items-center gap-2 text-left">
          <span className={`truncate ${done ? "text-faint" : "text-fg"}`}>
            {task.title}
          </span>
          {task.commentCount ? (
            <span
              className="flex shrink-0 items-center gap-1 text-xs text-faint"
              title={`${task.commentCount} comments`}
            >
              <MessageSquare aria-hidden size={12} strokeWidth={1.75} />
              {task.commentCount}
            </span>
          ) : null}
        </button>

        {/* Importance — click or "I" opens the picker; "1"/"2" set it directly.
            List-native trigger: the label when notable, a quiet flag otherwise. */}
        <div onClick={(e) => e.stopPropagation()} className="shrink-0">
          <QuickImportance
            importance={importance}
            onChange={onImportance}
            revealOnHover={false}
            renderTrigger={({ open, toggle }) => {
              const t = IMPORTANCE_TONE[importance];
              return importance !== 0 ? (
                <button
                  type="button"
                  onClick={toggle}
                  title="Importance"
                  className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${t.border} ${t.bg} ${t.text} ${open ? "ring-1 ring-accent" : ""}`}
                >
                  {IMPORTANCE_LABEL[importance]}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={toggle}
                  aria-label="Set importance"
                  title="Importance"
                  className={`grid h-4 w-4 place-items-center rounded text-xs transition-opacity ${
                    open
                      ? "text-accent opacity-100"
                      : "text-faint opacity-0 hover:text-fg group-hover:opacity-100"
                  }`}
                >
                  <Flag aria-hidden size={12} strokeWidth={1.75} />
                </button>
              );
            }}
          />
        </div>
      </div>

      {/* Assignees — click or "A" opens the picker; SPACE assigns the viewer.
          List-native trigger: the avatar stack (or a dashed "+" when empty). */}
      <div className="flex justify-center" onClick={(e) => e.stopPropagation()}>
        <QuickAssign
          taskId={node.id}
          assigneeIds={task.assigneeIds ?? []}
          onChange={onAssign}
          memberIds={memberIds}
          onEditMembers={onEditMembers}
          revealOnHover={false}
          renderTrigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-label="Assign"
              className={`flex items-center rounded-full ${open ? "ring-1 ring-accent" : ""}`}
            >
              {task.assigneeIds?.length ? (
                <AvatarStack ids={task.assigneeIds} />
              ) : (
                <span className="grid h-[22px] w-[22px] place-items-center rounded-full border border-dashed border-border-strong text-[10px] text-faint hover:border-accent hover:text-accent">
                  +
                </span>
              )}
            </button>
          )}
        />
      </div>

      {/* Status — click or "S" opens the picker. List-native pill trigger. */}
      <div onClick={(e) => e.stopPropagation()}>
        <QuickStatus
          status={node.status}
          onChange={onSetStatus}
          revealOnHover={false}
          renderTrigger={({ open, toggle }) => {
            const t = STATUS_TONE[node.status];
            return (
              <button
                type="button"
                onClick={toggle}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${t.bg} ${t.text} ${t.border} ${open ? "ring-1 ring-accent" : ""}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden />
                <span className="truncate">{STATUS_LABEL[node.status]}</span>
              </button>
            );
          }}
        />
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
