"use client";

import { useState, type DragEvent } from "react";
import type { Task, TaskStatus } from "@/lib/types";
import type { DropPos, TaskNode } from "./WorkspaceContext";
import { Avatar, PriorityFlag, TagChip } from "@/components/ui/Badge";
import { StatusPill } from "./StatusPill";
import { formatRelative, formatDue } from "@/lib/format";

/** Shared grid template so header and rows line up. */
export const GRID =
  "grid grid-cols-[minmax(240px,1fr)_52px_44px_150px_104px_92px] items-center";

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
  onToggleExpand,
  onOpen,
  onStart,
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
  onToggleExpand: () => void;
  onOpen: () => void;
  onStart: () => void;
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

        {/* quick-start (hover) → move to In progress */}
        {!inProgress && !done ? (
          <button
            onClick={onStart}
            title="Start (move to In Progress)"
            className="shrink-0 text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
          >
            ▶
          </button>
        ) : null}

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
      </div>

      {/* Assignee */}
      <div className="flex justify-center">
        {task.assignee ? (
          <Avatar name={task.assignee} />
        ) : (
          <span className="grid h-[22px] w-[22px] place-items-center rounded-full border border-dashed border-border-strong text-[10px] text-faint">
            +
          </span>
        )}
      </div>

      {/* Priority */}
      <div className="flex justify-center">
        {task.priority ? <PriorityFlag priority={task.priority} /> : null}
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
