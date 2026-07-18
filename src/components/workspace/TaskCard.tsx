"use client";

import { useState } from "react";
import type { Task } from "@/lib/types";
import { PointsChip } from "@/components/ui/Badge";
import { AvatarStack } from "@/components/PersonAvatar";
import { formatDue } from "@/lib/format";

/** Mime used to carry the dragged task id across kanban columns/boards. */
export const TASK_DND_MIME = "text/plain";

/**
 * A draggable kanban card. Click opens the task detail modal; drag it onto
 * another column (same or different board) to move it — the drop target reads
 * the id from the drag event.
 */
export function TaskCard({
  task,
  onOpen,
}: {
  task: Task;
  onOpen: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const done = task.status === "done";
  const due = task.dueDate ? formatDue(task.dueDate) : null;

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(TASK_DND_MIME, task.id);
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onClick={onOpen}
      className={[
        "group cursor-pointer rounded-lg border border-border bg-surface p-2.5 text-sm shadow-sm transition-colors hover:border-border-strong",
        dragging ? "opacity-40" : "",
      ].join(" ")}
    >
      <div className="flex items-start gap-2">
        <span className={`min-w-0 flex-1 ${done ? "text-faint line-through" : "text-fg"}`}>
          {task.title}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {task.value != null ? <PointsChip kind="value" points={task.value} /> : null}
          {task.difficulty != null ? (
            <PointsChip kind="difficulty" points={task.difficulty} />
          ) : null}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs text-faint">
        {task.assigneeIds?.length ? (
          <AvatarStack ids={task.assigneeIds} size={18} />
        ) : null}
        {task.recurrence && task.recurrence !== "none" ? (
          <span title={`Repeats ${task.recurrence}`}>↻</span>
        ) : null}
        {task.dependsOn?.length ? (
          <span title={`${task.dependsOn.length} dependency(ies)`}>⛔ {task.dependsOn.length}</span>
        ) : null}
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
        ) : null}
        {task.commentCount ? (
          <span className="ml-auto" title={`${task.commentCount} comments`}>
            💬 {task.commentCount}
          </span>
        ) : null}
      </div>
    </div>
  );
}
