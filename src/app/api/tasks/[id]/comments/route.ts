/*
  POST /api/tasks/:id/comments — add a note (human or AI) to a task.
*/

import { NextRequest } from "next/server";
import { route, json, error, body, commentSchema, type AuthedCtx } from "@/lib/api";
import { addComment } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const { message, author } = await body(req, commentSchema);
  const comment = await addComment(id, message, ctx.userId, author);
  if (!comment) return error("Task not found", 404);
  return json({ comment }, 201);
});
