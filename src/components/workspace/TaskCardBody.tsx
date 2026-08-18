"use client";

import type { Task, TaskStatus, Importance } from "@/lib/types";
import { Markdown } from "@/components/ui/Markdown";
import { AvatarStack } from "@/components/PersonAvatar";
import { QuickStatus } from "./QuickStatus";
import { QuickImportance } from "./QuickImportance";
import { QuickAssign } from "./QuickAssign";
import { useWorkspace } from "./WorkspaceContext";

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
export function TaskCardBody({
  task,
  h,
  neutralDone = false,
}: {
  task: Task;
  h: TaskCardHandlers;
  /** Stop treating done as a visual state — see `TaskCard`'s own prop. On the
   *  Done view every card is done, so the green title says nothing and the
   *  hidden description costs the only content there is to read. */
  neutralDone?: boolean;
}) {
  const id = task.id;
  const done = task.status === "done" && !neutralDone;
  // Scope the assign picker to the task's project members (mirrors the task
  // modal). Empty/undefined members ⇒ QuickAssign falls back to the whole
  // roster. `projectId` is set whenever the task is on a board/canvas section.
  const { projects, openProjectSettings } = useWorkspace();
  const taskProject = task.projectId
    ? projects.find((p) => p.id === task.projectId)
    : undefined;
  return (
    <div className="min-w-0 flex-1">
      <button
        onClick={(e) => {
          e.stopPropagation();
          h.onOpen(id);
        }}
        className={[
          "block w-full whitespace-normal break-words text-left text-sm font-semibold",
          done ? "text-buff" : "text-fg",
        ].join(" ")}
      >
        {task.title}
      </button>
      {task.description && !done ? (
        /* Size and tone are PROPS — set on the wrapper they lose to Markdown's
           own root classes, which is how this rendered at `text-sm text-fg` for
           a long time while asking for neither. */
        <div className="mt-0.5 line-clamp-6 italic">
          <Markdown size="xs" tone="muted">
            {task.description}
          </Markdown>
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
          <QuickAssign
            taskId={id}
            assigneeIds={task.assigneeIds ?? []}
            onChange={h.onAssign}
            memberIds={taskProject?.members}
            onEditMembers={
              taskProject ? () => openProjectSettings(taskProject.id) : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
