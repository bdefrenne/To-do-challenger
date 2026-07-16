/*
  /api/tasks/:id
    GET    — one task + its activity log/comments
    PATCH  — update fields (partial)
    DELETE — remove the task
*/

import { NextRequest } from "next/server";
import { route, json, error, body, updateTaskSchema, type AuthedCtx } from "@/lib/api";
import { getTask, updateTask, deleteTask } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const result = await getTask(id, ctx.userId);
  if (!result) return error("Task not found", 404);
  return json(result);
});

export const PATCH = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const patch = await body(req, updateTaskSchema);
  // Optional optimistic-concurrency check (see updateTask). A mismatch throws
  // ConflictError, which route() turns into a 409 carrying the fresh task.
  const ifMatch = req.headers.get("if-match") ?? undefined;
  const task = await updateTask(id, patch, ctx.userId, undefined, ifMatch);
  if (!task) return error("Task not found", 404);
  return json({ task });
});

export const DELETE = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const ok = await deleteTask(id, ctx.userId);
  if (!ok) return error("Task not found", 404);
  return json({ ok: true });
});
