"use client";

import { useParams } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { ViewToggle, useViewMode } from "@/components/ui/ViewToggle";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { BoardsColumns } from "@/components/workspace/BoardsColumns";
import { TaskTable } from "@/components/workspace/TaskTable";

/**
 * Project view. Two modes:
 *   • List (default) — every task across all of the project's boards,
 *     grouped by status, each row tagged with its board.
 *   • Boards — one column per board, tasks split by status dividers; drag a
 *     column handle to reorder the boards (and the sidebar).
 */
export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { projects } = useWorkspace();
  const project = projects.find((p) => p.id === projectId);
  const [view, setView] = useViewMode<"list" | "boards">("view-mode:project", "list");

  const boards = project?.boards ?? [];
  const boardIds = boards.map((b) => b.id);

  return (
    <div className="min-h-screen">
      <PageHeader
        title={project?.name ?? "Project"}
        subtitle={
          view === "list"
            ? "Every task across this project's boards, grouped by status."
            : "One column per board. Drag a card onto a status, or a column handle to reorder boards."
        }
        right={
          <ViewToggle
            value={view}
            onChange={setView}
            options={[
              { value: "list", label: "List" },
              { value: "boards", label: "Boards" },
            ]}
          />
        }
      />
      <div className="px-8 py-6">
        {!project ? (
          <p className="text-sm text-faint">Loading project…</p>
        ) : view === "list" ? (
          <TaskTable
            boardIds={boardIds}
            showBoardChip
            addBoardId={boardIds[0] ?? null}
          />
        ) : (
          <BoardsColumns project={project} />
        )}
      </div>
    </div>
  );
}
