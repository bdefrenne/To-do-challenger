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

  // Deleting a board takes its tasks with it, so the confirm spells out how
  // many are on the line.
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
      onDelete={
        mode === "edit" && board
          ? async () => {
              if (
                !confirm(
                  `Delete board “${board.name}”${
                    taskCount > 0
                      ? ` and its ${taskCount} task${taskCount === 1 ? "" : "s"}`
                      : ""
                  }? This can't be undone.`,
                )
              )
                return;
              await deleteBoard(board.id);
              if (pathname === `/boards/${board.id}`)
                router.push(projectId ? `/projects/${projectId}` : "/");
              onClose();
            }
          : undefined
      }
      deleteHint={
        taskCount > 0
          ? `Permanently delete this board and its ${taskCount} task${
              taskCount === 1 ? "" : "s"
            }.`
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
