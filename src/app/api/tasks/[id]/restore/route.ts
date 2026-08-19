/*
  POST /api/tasks/:id/restore — bring a task back from the Trash, with its
  subtree. A restored task whose parent is still deleted is un-nested to top
  level so it lands somewhere visible (see `restoreTask`).
*/

import { NextRequest } from "next/server";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { restoreTask } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const task = await restoreTask(id, ctx.userId);
  if (!task) return error("Task not found", 404);
  return json({ task });
});
