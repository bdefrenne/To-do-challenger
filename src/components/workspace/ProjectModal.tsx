"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { EntityFormModal } from "./EntityFormModal";
import { ProjectMembersField } from "./ProjectMembersField";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
import { usePeople } from "@/components/PeopleContext";
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
  // delete a clean, cascade-free removal (nothing to orphan).
  const boardIds = new Set((project?.boards ?? []).map((b) => b.id));
  const taskCount =
    mode === "edit" && project
      ? Object.values(taskMap).filter(
          (t) =>
            t.projectId === project.id ||
            (t.boardId != null && boardIds.has(t.boardId)),
        ).length
      : 0;

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
                    `${project.boards?.length ?? 0} board(s). This can't be undone.`,
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
          : "Permanently delete this project and its boards."
      }
      extraSection={
        <ProjectMembersField selected={memberIds} onChange={setMemberIds} />
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
