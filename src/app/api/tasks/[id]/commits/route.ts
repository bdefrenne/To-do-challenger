/*
  /api/tasks/:id/commits
    POST — link a git commit to the task (auto-starts the work clock)
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  linkCommitSchema,
  type AuthedCtx,
} from "@/lib/api";
import { linkCommit } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const { sha, subject } = await body(req, linkCommitSchema);
  const commit = await linkCommit(id, sha, subject ?? null, ctx.userId);
  if (!commit) return error("Task not found", 404);
  return json({ commit }, 201);
});
