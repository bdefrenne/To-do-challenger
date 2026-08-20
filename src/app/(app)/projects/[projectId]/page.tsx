"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { Avatar } from "@/components/ui/Badge";
import { ViewToggle, useViewMode } from "@/components/ui/ViewToggle";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { BoardsColumns } from "@/components/workspace/BoardsColumns";
import { ProjectModal } from "@/components/workspace/ProjectModal";
import { EntityReadme } from "@/components/workspace/EntityReadme";
import { TaskTable } from "@/components/workspace/TaskTable";
import { DoneBoards } from "@/components/workspace/DoneBoards";
import { ArchiveDoneButton } from "@/components/workspace/ArchiveDoneButton";

/**
 * Project view. Three modes:
 *   • List (default) — every task across all of the project's boards,
 *     grouped by status, each row tagged with its board.
 *   • Boards — the triage ladder as collapsible separators (INBOX · DONE THIS
 *     WEEK · THIS WEEK · BACKLOG · LATER), each holding one column per
 *     board; drag a column handle to reorder the boards (and the sidebar).
 *   • Done — what actually got finished, as collapsible weeks and days, each day
 *     holding one column per person cut across by a band per board.
 */
export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { projects } = useWorkspace();
  const project = projects.find((p) => p.id === projectId);
  const [view, setView] = useViewMode<"list" | "boards" | "done">(
    "view-mode:project",
    "list",
  );
  const [editing, setEditing] = useState(false);
  // This project's canvas — exactly one (TD-136), so the lookup returns 0 or 1.
  // Fetched rather than read from the workspace store, which doesn't hold
  // canvases (they're outside the task poll).
  const [canvasId, setCanvasId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch(
        `/api/canvases?projectId=${encodeURIComponent(projectId)}`,
      );
      if (!alive || !res.ok) return;
      const { canvases } = (await res.json()) as { canvases: { id: string }[] };
      setCanvasId(canvases[0]?.id ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

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
            {canvasId ? (
              <Link
                href={`/canvas/${canvasId}`}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                Canvas
              </Link>
            ) : null}
            {project ? <ArchiveDoneButton projectId={project.id} /> : null}
            <ViewToggle
              value={view}
              onChange={setView}
              options={[
                { value: "list", label: "List" },
                { value: "boards", label: "Boards" },
                { value: "done", label: "Done" },
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
            ) : view === "boards" ? (
              <BoardsColumns project={project} />
            ) : (
              <DoneBoards project={project} />
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
