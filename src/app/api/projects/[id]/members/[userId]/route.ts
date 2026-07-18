/*
  DELETE /api/projects/:id/members/:userId — remove a member from a project.

  Owner-scoped; the owner themselves can't be removed (they're pinned so tasks
  that auto-assign to them stay valid). Returns the new member id list.
*/

import { NextRequest } from "next/server";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { removeProjectMember } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id, userId: memberId } = await ctx.params;
  const members = await removeProjectMember(ctx.userId, id, memberId);
  if (!members) return error("Project not found", 404);
  return json({ members });
});
