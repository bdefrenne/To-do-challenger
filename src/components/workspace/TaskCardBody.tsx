"use client";

import type { Task, TaskStatus, Importance } from "@/lib/types";
import { Markdown } from "@/components/ui/Markdown";
import { AvatarStack } from "@/components/PersonAvatar";
import { QuickStatus } from "./QuickStatus";
import { QuickImportance } from "./QuickImportance";
import { QuickAssign } from "./QuickAssign";

/** The id-based handlers a card's controls call. Same shape the canvas Section
 *  and the kanban board both already have from `useWorkspace()`. */
export interface TaskCardHandlers {
  onOpen: (id: string) => void;
  onStatus: (id: string, s: TaskStatus) => void;
  onImportance: (id: string, v: Importance) => void;
  onAssign: (id: string, patch: { assigneeIds: string[] }) => void;
}

/**
 * The shared inner content of a task card — title, description, assignees, and
 * the hover S / I / A pickers. Both the canvas Section card and the kanban board
 * card render this inside their OWN `group/card` container + DnD wrapper, so the
 * visible card and its controls are identical across surfaces while each keeps
 * its own drag semantics. The pickers reveal on `group-hover/card`, so the
 * wrapping container MUST carry the `group/card` class.
 */
export function TaskCardBody({ task, h }: { task: Task; h: TaskCardHandlers }) {
  const id = task.id;
  const done = task.status === "done";
  return (
    <div className="min-w-0 flex-1">
      <button
        onClick={(e) => {
          e.stopPropagation();
          h.onOpen(id);
        }}
        className={[
          "block w-full truncate text-left text-sm font-semibold",
          done ? "text-buff line-through" : "text-fg",
        ].join(" ")}
      >
        {task.title}
      </button>
      {task.description && !done ? (
        <div className="mt-0.5 line-clamp-6 text-xs italic text-muted">
          <Markdown>{task.description}</Markdown>
        </div>
      ) : null}
      <div className="mt-1 flex items-center gap-2">
        {task.assigneeIds?.length ? <AvatarStack ids={task.assigneeIds} size={18} /> : null}
        {/* Hover-only controls: status (S) + importance (I) + assign (A).
            Done is toggled with D on the card. */}
        <div className="ml-auto flex items-center gap-1">
          <QuickStatus status={task.status} onChange={(s) => h.onStatus(id, s)} />
          <QuickImportance
            importance={task.importance ?? 0}
            onChange={(v) => h.onImportance(id, v)}
          />
          <QuickAssign taskId={id} assigneeIds={task.assigneeIds ?? []} onChange={h.onAssign} />
        </div>
      </div>
    </div>
  );
}
