"use client";

import { usePathname, useRouter } from "next/navigation";
import { EntityFormModal } from "./EntityFormModal";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import type { Board } from "@/lib/types";

/**
 * Create or edit a board (name, shortname, color, picture, git folder, and a
 * Markdown readme). Thin wrapper over {@link EntityFormModal} that wires the
 * board create/update/avatar-upload/delete actions — deleting a board lives
 * here (in edit mode) rather than on the board itself, mirroring
 * {@link ProjectModal}.
 */
export function BoardModal({
  mode,
  projectId,
  board,
  onClose,
}: {
  mode: "create" | "edit";
  /** Required in create mode. */
  projectId?: string;
  /** Required in edit mode. */
  board?: Board;
  onClose: () => void;
}) {
  const { createBoard, renameBoard, uploadBoardAvatar, deleteBoard, taskMap } =
    useWorkspace();
  const router = useRouter();
  const pathname = usePathname();

  // A board that still holds tasks can't be deleted (see onDelete below), so
  // this count is what the delete button is disabled ON, and what the hint names.
  const taskCount =
    mode === "edit" && board
      ? Object.values(taskMap).filter((t) => t.boardId === board.id).length
      : 0;

  return (
    <EntityFormModal
      title={mode === "create" ? "New board" : "Board settings"}
      submitLabel={mode === "create" ? "Create board" : "Save"}
      namePlaceholder="Board name"
      descriptionHint="explain the board so code-less AIs understand it"
      initial={board ?? {}}
      onClose={onClose}
      // Same rule as a project (and enforced server-side in `deleteBoard`): a
      // board that still holds tasks can't be deleted. Deleting the row would
      // cascade its tasks out of Postgres — the one exit that skips the Trash —
      // so the tasks leave first, through a door that has an undo.
      onDelete={
        mode === "edit" && board
          ? async () => {
              if (taskCount > 0) return;
              if (!confirm(`Delete board “${board.name}”? This can't be undone.`)) return;
              await deleteBoard(board.id);
              if (pathname === `/boards/${board.id}`)
                router.push(projectId ? `/projects/${projectId}` : "/");
              onClose();
            }
          : undefined
      }
      deleteDisabled={taskCount > 0}
      deleteHint={
        taskCount > 0
          ? `Move or delete this board's ${taskCount} task${
              taskCount === 1 ? "" : "s"
            } before deleting it — deleting a board would destroy them outright, ` +
            `without the Trash.`
          : "Permanently delete this board."
      }
      onSave={async (v, pic) => {
        if (mode === "create") {
          if (!projectId) return false;
          const created = await createBoard(projectId, {
            name: v.name,
            code: v.code || undefined,
            color: v.color || undefined,
            gitFolder: v.gitFolder || undefined,
            description: v.description || undefined,
          });
          if (!created) return false;
          if (pic.blob) await uploadBoardAvatar(created.id, pic.blob);
          return true;
        }
        if (!board) return false;
        await renameBoard(board.id, {
          name: v.name,
          code: v.code || undefined,
          color: v.color || undefined,
          gitFolder: v.gitFolder || null,
          description: v.description || null,
          ...(pic.remove && !pic.blob ? { image: null } : {}),
        });
        if (pic.blob) await uploadBoardAvatar(board.id, pic.blob);
        return true;
      }}
    />
  );
}
