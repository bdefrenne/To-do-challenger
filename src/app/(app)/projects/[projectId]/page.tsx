"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Avatar } from "@/components/ui/Badge";
import { ViewToggle, useViewMode } from "@/components/ui/ViewToggle";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { BoardsColumns } from "@/components/workspace/BoardsColumns";
import { ProjectModal } from "@/components/workspace/ProjectModal";
import { EntityReadme } from "@/components/workspace/EntityReadme";
import { TaskTable } from "@/components/workspace/TaskTable";
import { ArchiveDoneButton } from "@/components/workspace/ArchiveDoneButton";

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
  const [editing, setEditing] = useState(false);

  const boards = project?.boards ?? [];
  const boardIds = boards.map((b) => b.id);

  return (
    <div className="min-h-screen">
      <PageHeader
        title={project?.name ?? "Project"}
        subtitle={project?.code ?? undefined}
        left={
          project ? (
            <Avatar
              name={project.name}
              size={32}
              imageUrl={project.image}
              color={project.color}
            />
          ) : undefined
        }
        right={
          <>
            {project ? (
              <button
                onClick={() => setEditing(true)}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                Settings
              </button>
            ) : null}
            {project ? <ArchiveDoneButton projectId={project.id} /> : null}
            <ViewToggle
              value={view}
              onChange={setView}
              options={[
                { value: "list", label: "List" },
                { value: "boards", label: "Boards" },
              ]}
            />
          </>
        }
      />
      <div className="px-8 py-6">
        {!project ? (
          <p className="text-sm text-faint">Loading project…</p>
        ) : (
          <>
            <EntityReadme
              gitFolder={project.gitFolder}
              description={project.description}
            />
            {view === "list" ? (
              <TaskTable boardIds={boardIds} addBoardId={boardIds[0] ?? null} />
            ) : (
              <BoardsColumns project={project} />
            )}
          </>
        )}
      </div>

      {editing && project ? (
        <ProjectModal
          mode="edit"
          project={project}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}
