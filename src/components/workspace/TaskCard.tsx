"use client";

import { useRef, useState } from "react";
import type { Task } from "@/lib/types";
import { TaskCardBody, type TaskCardHandlers } from "./TaskCardBody";
import { useWorkspace } from "./WorkspaceContext";
import { useCardShortcut } from "./useCardShortcut";
import { IMPORTANCE_CARD } from "@/lib/importance";

/** Mime used to carry the dragged task id across kanban columns/boards. */
export const TASK_DND_MIME = "text/plain";

/**
 * A draggable kanban card. Renders the SAME body as the canvas Section card
 * (<TaskCardBody/> — title, description, assignees, hover S/I/A pickers) inside
 * a kanban-flavored container: click opens the modal, drag onto another column
 * (same or different board) moves it, and **D** while hovering toggles done.
 */
export function TaskCard({
  task,
  onOpen,
}: {
  task: Task;
  onOpen: () => void;
}) {
  const { setStatus, editTask, toggleDone } = useWorkspace();
  const [dragging, setDragging] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const id = task.id;
  const done = task.status === "done";
  const c = IMPORTANCE_CARD[task.importance ?? 0];

  // "D" on the hovered card toggles done: not-done → done; done → building
  // (setStatus clears completedAt), mirroring the canvas Section card.
  useCardShortcut(cardRef, "d", () => {
    if (done) setStatus(id, "building");
    else toggleDone(id);
  });

  const h: TaskCardHandlers = {
    onOpen: () => onOpen(),
    onStatus: (tid, s) => setStatus(tid, s),
    onImportance: (tid, v) => editTask(tid, { importance: v }),
    onAssign: (tid, patch) => editTask(tid, patch),
  };

  return (
    <div
      ref={cardRef}
      data-card
      data-task-id={id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(TASK_DND_MIME, id);
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onClick={onOpen}
      className={[
        "group/card cursor-pointer rounded-lg border px-2 py-1.5 transition-colors",
        done
          ? "border-buff/40 bg-buff-soft hover:border-buff/60"
          : `${c.border} ${c.bg} ${c.hover}`,
        dragging ? "opacity-40" : "",
      ].join(" ")}
    >
      <TaskCardBody task={task} h={h} />
    </div>
  );
}
