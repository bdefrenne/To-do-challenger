/*
  /api/projects/:id
    PATCH  — rename the project.
    DELETE — remove the project (cascades to its boards and their tasks).
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  updateProjectSchema,
  type AuthedCtx,
} from "@/lib/api";
import { updateProject, deleteProject } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const patch = await body(req, updateProjectSchema);
  const project = await updateProject(ctx.userId, id, patch);
  if (!project) return error("Project not found", 404);
  return json({ project });
});

export const DELETE = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const ok = await deleteProject(ctx.userId, id);
  if (!ok) return error("Project not found", 404);
  return json({ ok: true });
});
