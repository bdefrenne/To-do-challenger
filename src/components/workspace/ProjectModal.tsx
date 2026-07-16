"use client";

import { EntityFormModal } from "./EntityFormModal";
import { useWorkspace } from "@/components/workspace/WorkspaceContext";
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
  const { createProject, renameProject, uploadProjectAvatar } = useWorkspace();

  return (
    <EntityFormModal
      title={mode === "create" ? "New project" : "Project settings"}
      submitLabel={mode === "create" ? "Create project" : "Save"}
      namePlaceholder="Project name"
      descriptionHint="explain the project so code-less AIs understand it"
      initial={project ?? {}}
      onClose={onClose}
      onSave={async (v, pic) => {
        if (mode === "create") {
          const created = await createProject({
            name: v.name,
            code: v.code || undefined,
            color: v.color || undefined,
            gitFolder: v.gitFolder || undefined,
            description: v.description || undefined,
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
          ...(pic.remove && !pic.blob ? { image: null } : {}),
        });
        if (pic.blob) await uploadProjectAvatar(project.id, pic.blob);
        return true;
      }}
    />
  );
}
