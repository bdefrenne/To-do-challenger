/*
  /api/tasks/:id
    GET    — one task + its activity log/comments
    PATCH  — update fields (partial)
    DELETE — move the task to the Trash (a soft delete: it keeps its id, ref
             and subtree, and can be restored). `?forever=1` on a task that is
             ALREADY in the Trash deletes it for good — rows, logs, blobs and
             all — and 400s on a live task, so permanent deletion is always the
             second of two deliberate steps.
*/

import { NextRequest } from "next/server";
import { route, json, error, body, updateTaskSchema, type AuthedCtx } from "@/lib/api";
import { getTask, updateTask, deleteTask, purgeTask } from "@/lib/db/service";

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
  // Deliberately NOT the standard `If-Match`: Vercel's edge evaluates HTTP
  // preconditions before we ever see the response and rewrites it to a 412
  // PRECONDITION_FAILED, so the write lands but the caller sees an error.
  const expected = req.headers.get("x-expected-updated-at") ?? undefined;
  const task = await updateTask(id, patch, ctx.userId, undefined, expected);
  if (!task) return error("Task not found", 404);
  return json({ task });
});

export const DELETE = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const forever = sp.has("forever") && sp.get("forever") !== "false" && sp.get("forever") !== "0";
  const ok = forever ? await purgeTask(id, ctx.userId) : await deleteTask(id, ctx.userId);
  if (!ok) return error("Task not found", 404);
  return json({ ok: true, deleted: forever ? "forever" : "trash" });
});
