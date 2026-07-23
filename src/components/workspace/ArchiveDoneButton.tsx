"use client";

import { useState } from "react";
import { useWorkspace } from "./WorkspaceContext";

/**
 * "Archive done (N)" header action — archives every done task in scope (a board
 * via `boardId`, a project via `projectId`, else all) into the Archived view.
 * Hidden when nothing is done. Mirrors the per-task Delete-on-done archive, in
 * bulk.
 */
export function ArchiveDoneButton({
  boardId,
  projectId,
}: {
  boardId?: string;
  projectId?: string;
}) {
  const { nodes, projects, archiveAllDone } = useWorkspace();
  const [busy, setBusy] = useState(false);

  const projectBoardIds = projectId
    ? new Set((projects.find((p) => p.id === projectId)?.boards ?? []).map((b) => b.id))
    : null;
  const inScope = (bId: string | null | undefined) =>
    boardId ? bId === boardId : projectBoardIds ? bId != null && projectBoardIds.has(bId) : true;
  const doneCount = nodes.filter((n) => n.status === "done" && inScope(n.boardId)).length;
  if (!doneCount) return null;

  return (
    <button
      disabled={busy}
      onClick={async () => {
        if (
          !confirm(
            `Archive ${doneCount} done task${doneCount === 1 ? "" : "s"}? ` +
              `They move to the Archived view and can be restored later.`,
          )
        )
          return;
        setBusy(true);
        try {
          await archiveAllDone({ boardId, projectId });
        } finally {
          setBusy(false);
        }
      }}
      className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
    >
      {busy ? "Archiving…" : `Archive done (${doneCount})`}
    </button>
  );
}
