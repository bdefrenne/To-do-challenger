"use client";

import { useParams } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { ViewToggle, useViewMode } from "@/components/ui/ViewToggle";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { KanbanBoard } from "@/components/workspace/KanbanBoard";
import { TaskTable } from "@/components/workspace/TaskTable";

/**
 * Single-board view. Two modes:
 *   • List (default) — the board's tasks grouped by status.
 *   • Board — the Trello-style kanban with a column per status.
 */
export default function BoardPage() {
  const { boardId } = useParams<{ boardId: string }>();
  const { projects } = useWorkspace();
  const project = projects.find((p) => p.boards?.some((b) => b.id === boardId));
  const board = project?.boards?.find((b) => b.id === boardId);
  const [view, setView] = useViewMode<"list" | "board">("view-mode:board", "list");

  return (
    <div className="min-h-screen">
      <PageHeader
        title={board?.name ?? "Board"}
        subtitle={project ? `in ${project.name}` : undefined}
        right={
          <ViewToggle
            value={view}
            onChange={setView}
            options={[
              { value: "list", label: "List" },
              { value: "board", label: "Board" },
            ]}
          />
        }
      />
      <div className="px-8 py-6">
        {!board ? (
          <p className="text-sm text-faint">Loading board…</p>
        ) : view === "list" ? (
          <TaskTable boardIds={[board.id]} addBoardId={board.id} />
        ) : (
          <KanbanBoard boardId={board.id} />
        )}
      </div>
    </div>
  );
}
