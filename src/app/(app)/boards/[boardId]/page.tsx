"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Avatar } from "@/components/ui/Badge";
import { ViewToggle, useViewMode } from "@/components/ui/ViewToggle";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { KanbanBoard } from "@/components/workspace/KanbanBoard";
import { TaskTable } from "@/components/workspace/TaskTable";
import { EntityReadme } from "@/components/workspace/EntityReadme";
import { BoardModal } from "@/components/workspace/BoardModal";
import { ArchiveDoneButton } from "@/components/workspace/ArchiveDoneButton";

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
  const [editing, setEditing] = useState(false);

  return (
    <div className="min-h-screen">
      <PageHeader
        title={board?.name ?? "Board"}
        subtitle={
          board?.code
            ? `${board.code}${project ? ` · in ${project.name}` : ""}`
            : project
              ? `in ${project.name}`
              : undefined
        }
        left={
          board ? (
            <Avatar
              name={board.name}
              size={32}
              imageUrl={board.image}
              color={board.color}
            />
          ) : undefined
        }
        right={
          <>
            {board ? (
              <button
                onClick={() => setEditing(true)}
                className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                Settings
              </button>
            ) : null}
            {board ? <ArchiveDoneButton boardId={board.id} /> : null}
            <ViewToggle
              value={view}
              onChange={setView}
              options={[
                { value: "list", label: "List" },
                { value: "board", label: "Board" },
              ]}
            />
          </>
        }
      />
      <div className="px-8 py-6">
        {!board ? (
          <p className="text-sm text-faint">Loading board…</p>
        ) : (
          <>
            <EntityReadme
              gitFolder={board.gitFolder}
              description={board.description}
            />
            {view === "list" ? (
              <TaskTable boardIds={[board.id]} addBoardId={board.id} />
            ) : (
              <KanbanBoard boardId={board.id} />
            )}
          </>
        )}
      </div>

      {editing && board ? (
        <BoardModal
          mode="edit"
          projectId={board.projectId}
          board={board}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}
