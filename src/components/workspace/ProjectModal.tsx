"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { EntityFormModal } from "./EntityFormModal";
import { ProjectMembersField } from "./ProjectMembersField";
import { BoardVisibilityField } from "./BoardVisibilityField";
import { allBoards } from "@/lib/boards";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { usePeople } from "@/components/PeopleContext";
import { useHiddenTaskCount, hiddenTasksPhrase } from "./useHiddenTaskCount";
import type { Project } from "@/lib/types";

/**
 * Create or edit a project (name, shortname, color, picture, git folder, and a
 * Markdown readme). Thin wrapper over {@link EntityFormModal} that wires the
 * project create/update/avatar-upload actions.
 */
export function ProjectModal({
  mode,
  project,
  onClose,
}: {
  mode: "create" | "edit";
  /** Required in edit mode. */
  project?: Project;
  onClose: () => void;
}) {
  const { createProject, renameProject, uploadProjectAvatar, deleteProject, taskMap } =
    useWorkspace();
  const { me } = usePeople();
  const router = useRouter();
  const pathname = usePathname();

  // Member set (roster user ids). Read by onSave below — EntityFormModal owns
  // the other fields. On a NEW project, pre-select the current user as a
  // convenience (removable); on edit, load the project's actual members.
  const [memberIds, setMemberIds] = useState<string[]>(
    project?.members ?? (mode === "create" && me ? [me.id] : []),
  );

  // A project can only be deleted once it's empty — no tasks on any of its
  // boards, and no board-less tasks scoped directly to it. That keeps the
  // delete a clean, cascade-free removal (nothing to orphan). Hidden boards
  // count (TD2-213): they still hold their tasks, and a delete guard that
  // couldn't see them would wave through a project whose cascade takes work
  // with it — hiding a board must never be a way past a fence.
  // Only LIVE tasks block it (TD2-214) — which is exactly what `taskMap` holds,
  // so this count and the server's now agree.
  const boardIds = new Set(allBoards(project ?? {}).map((b) => b.id));
  const taskCount =
    mode === "edit" && project
      ? Object.values(taskMap).filter(
          (t) =>
            t.projectId === project.id ||
            (t.boardId != null && boardIds.has(t.boardId)),
        ).length
      : 0;

  // Archived and trashed tasks don't block the delete, but the cascade destroys
  // them with no Trash behind it — so say how many before asking (TD2-214).
  const hidden = useHiddenTaskCount(mode === "edit" && project ? { projectId: project.id } : null);
  const doomed = hiddenTasksPhrase(hidden);

  return (
    <EntityFormModal
      title={mode === "create" ? "New project" : "Project settings"}
      submitLabel={mode === "create" ? "Create project" : "Save"}
      namePlaceholder="Project name"
      descriptionHint="explain the project so code-less AIs understand it"
      initial={project ?? {}}
      onClose={onClose}
      onDelete={
        mode === "edit" && project
          ? async () => {
              if (taskCount > 0) return;
              if (
                !confirm(
                  `Delete project “${project.name}”? This also removes its ` +
                    `${allBoards(project).length} board(s). ` +
                    (doomed
                      ? `The ${doomed} in it will be destroyed too — permanently, with no ` +
                        `Trash to restore from. `
                      : "") +
                    `This can't be undone.`,
                )
              )
                return;
              await deleteProject(project.id);
              if (pathname === `/projects/${project.id}`) router.push("/");
              onClose();
            }
          : undefined
      }
      deleteDisabled={taskCount > 0}
      deleteHint={
        taskCount > 0
          ? `Move or delete this project's ${taskCount} task${
              taskCount === 1 ? "" : "s"
            } before deleting it.`
          : doomed
            ? `Permanently delete this project and its boards — the ${doomed} in them ` +
              `will be destroyed too.`
            : "Permanently delete this project and its boards."
      }
      extraSection={
        <div className="space-y-3">
          <ProjectMembersField selected={memberIds} onChange={setMemberIds} />
          {/* Edit only: hiding is a property of a board, and on create there
              are none yet. */}
          {mode === "edit" && project ? (
            <BoardVisibilityField project={project} />
          ) : null}
        </div>
      }
      onSave={async (v, pic) => {
        if (mode === "create") {
          const created = await createProject({
            name: v.name,
            code: v.code || undefined,
            color: v.color || undefined,
            gitFolder: v.gitFolder || undefined,
            description: v.description || undefined,
            members: memberIds,
          });
          if (!created) return false;
          if (pic.blob) await uploadProjectAvatar(created.id, pic.blob);
          return true;
        }
        if (!project) return false;
        await renameProject(project.id, {
          name: v.name,
          code: v.code || undefined,
          color: v.color || undefined,
          gitFolder: v.gitFolder || null,
          description: v.description || null,
          members: memberIds,
          ...(pic.remove && !pic.blob ? { image: null } : {}),
        });
        if (pic.blob) await uploadProjectAvatar(project.id, pic.blob);
        return true;
      }}
    />
  );
}
