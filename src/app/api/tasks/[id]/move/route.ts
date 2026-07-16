/*
  POST /api/tasks/:id/move — change a task's parent, status, and/or
  position (the reorder / nest / drag-drop primitive).
*/

import { NextRequest } from "next/server";
import { route, json, error, body, moveTaskSchema, type AuthedCtx } from "@/lib/api";
import { moveTask } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const target = await body(req, moveTaskSchema);
  const task = await moveTask(id, target, ctx.userId);
  if (!task) return error("Task not found", 404);
  return json({ task });
});
