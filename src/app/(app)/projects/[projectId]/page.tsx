"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Avatar } from "@/components/ui/Badge";
import { ViewToggle, useViewMode } from "@/components/ui/ViewToggle";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { BoardsColumns } from "@/components/workspace/BoardsColumns";
import { EntityReadme } from "@/components/workspace/EntityReadme";
import { TaskTable } from "@/components/workspace/TaskTable";
import { DoneBoards } from "@/components/workspace/DoneBoards";
import { ArchiveDoneButton } from "@/components/workspace/ArchiveDoneButton";
import { ClearDoneButton } from "@/components/workspace/ClearDoneButton";
import { AssigneeFilter } from "@/components/workspace/AssigneeFilter";
import { BoardFilter } from "@/components/workspace/BoardFilter";
import { useProjectFilters } from "@/components/workspace/useProjectFilters";
import { useProjectPlacements } from "@/components/workspace/useProjectPlacements";

/**
 * Project view. Three modes:
 *   • List (default) — every task across all of the project's boards,
 *     grouped by status, each row tagged with its board.
 *   • Boards — the triage ladder as collapsible separators (INBOX · DONE THIS
 *     WEEK · THIS WEEK · BACKLOG · LATER), each holding one column per
 *     board; drag a column handle to reorder the boards (and the sidebar).
 *   • Done — what actually got finished, as collapsible weeks and days, each day
 *     holding one column per person cut across by a band per board.
 *
 * All three read ONE pair of filters (TD2-216) — whose work, and which boards —
 * held here rather than per view, so the answer survives switching between them.
 * They're render filters: what a view draws, never what it writes.
 *
 * The header carries the two bulk exits for finished work, in the order you use
 * them: "Clear Done" parks every done card in the project in DONE THIS WEEK
 * (TD2-218 — it used to be one button per board column), and "Archive done"
 * takes them out of the week. Project settings and the canvas used to sit here
 * too and don't any more: the sidebar's per-project gear opens the same settings
 * modal, and its Canvas page lists every project's canvas.
 */
export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { projects } = useWorkspace();
  const project = projects.find((p) => p.id === projectId);
  const [view, setView] = useViewMode<"list" | "boards" | "done">(
    "view-mode:project",
    "list",
  );
  const boards = useMemo(() => project?.boards ?? [], [project?.boards]);
  const filters = useProjectFilters(projectId, boards);
  // One copy for the page: the Boards view's bands and the header's "Clear Done"
  // both resolve buckets against it (TD2-218).
  const { placements, titles } = useProjectPlacements(projectId);
  // What the views actually draw: the board filter narrows this, and the List
  // view needs nothing else — its scope is already a board-id list.
  const boardIds = useMemo(
    () => filters.visibleBoards.map((b) => b.id),
    [filters.visibleBoards],
  );

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
              <ClearDoneButton
                boards={boards}
                placements={placements}
                titles={titles}
              />
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
            {/* One filter bar for all three views. Below the header rather than
                in it: the header is the project's identity and its actions,
                these change what you're looking at. */}
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <AssigneeFilter
                value={filters.assigneeId}
                onChange={filters.setAssigneeId}
              />
              {boards.length > 1 ? (
                <BoardFilter
                  boards={boards}
                  value={filters.boardIds}
                  onChange={filters.setBoardIds}
                />
              ) : null}
            </div>
            {view === "list" ? (
              <TaskTable
                boardIds={boardIds}
                addBoardId={boardIds[0] ?? null}
                assigneeId={filters.assigneeId}
              />
            ) : view === "boards" ? (
              <BoardsColumns
                project={project}
                filters={filters}
                placements={placements}
                titles={titles}
              />
            ) : (
              <DoneBoards project={project} filters={filters} />
            )}
          </>
        )}
      </div>

    </div>
  );
}
