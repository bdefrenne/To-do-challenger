"use client";

import { useState, type DragEvent } from "react";
import type { Task, TaskStatus } from "@/lib/types";
import type { DropPos, TaskNode } from "./WorkspaceContext";
import { PointsChip, TagChip } from "@/components/ui/Badge";
import { AvatarStack } from "@/components/PersonAvatar";
import { StatusPill } from "./StatusPill";
import { BoardPill, type BoardGroup } from "./BoardPill";
import { formatRelative, formatDue } from "@/lib/format";

/** Shared grid template so header and rows line up. */
export const GRID =
  "grid grid-cols-[minmax(240px,1fr)_64px_96px_150px_104px_92px] items-center";

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
  boardGroups,
  onChangeBoard,
  onToggleExpand,
  onOpen,
  onToggleDone,
  onSetStatus,
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
  /** Boards the task may move to, grouped by project (see BoardPill). */
  boardGroups: BoardGroup[];
  /** Move the task onto another board. */
  onChangeBoard: (boardId: string) => void;
  onToggleExpand: () => void;
  onOpen: () => void;
  onToggleDone: () => void;
  onSetStatus: (s: TaskStatus) => void;
  onDragStartRow: (id: string) => void;
  onDropRow: (targetId: string, pos: DropPos) => void;
}) {
  const [pos, setPos] = useState<DropPos | null>(null);
  const done = node.status === "done";
  const isDragging = draggingId === node.id;
  const inProgress = node.status === "in-progress";
  const due = task.dueDate ? formatDue(task.dueDate) : null;

  function zoneFromEvent(e: DragEvent<HTMLDivElement>): DropPos {
    const r = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - r.top;
    if (y < r.height * 0.3) return "before";
    if (y > r.height * 0.7) return "after";
    return "inside";
  }

  return (
    <div
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
        "group relative border-b border-border px-3 py-2 text-sm transition-colors",
        inProgress ? "bg-new-soft/40" : "hover:bg-surface-2",
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
          {(task.tags ?? []).map((t) => (
            <TagChip key={t} id={t} />
          ))}
          {task.commentCount ? (
            <span className="shrink-0 text-xs text-faint" title={`${task.commentCount} comments`}>
              💬 {task.commentCount}
            </span>
          ) : null}
        </button>

        {/* Board picker — sibling of the title button (can't nest buttons). */}
        <BoardPill
          currentBoardId={currentBoardId}
          currentBoardName={currentBoardName}
          groups={boardGroups}
          onChange={onChangeBoard}
        />
      </div>

      {/* Assignees */}
      <div className="flex justify-center">
        {task.assignees?.length ? (
          <AvatarStack names={task.assignees} />
        ) : (
          <span className="grid h-[22px] w-[22px] place-items-center rounded-full border border-dashed border-border-strong text-[10px] text-faint">
            +
          </span>
        )}
      </div>

      {/* Points (value / difficulty) */}
      <div className="flex justify-center gap-1">
        {task.value != null ? <PointsChip kind="value" points={task.value} /> : null}
        {task.difficulty != null ? (
          <PointsChip kind="difficulty" points={task.difficulty} />
        ) : null}
        {task.value == null && task.difficulty == null ? (
          <span className="text-faint">—</span>
        ) : null}
      </div>

      {/* Status */}
      <div onClick={(e) => e.stopPropagation()}>
        <StatusPill status={node.status} onChange={onSetStatus} />
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
