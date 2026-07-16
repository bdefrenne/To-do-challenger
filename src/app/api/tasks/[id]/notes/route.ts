/*
  /api/tasks/:id/notes
    GET  — team notes on this task
    POST — add a note (standup material)
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  addNoteSchema,
  type AuthedCtx,
} from "@/lib/api";
import { addNote, listNotes } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const notes = await listNotes(ctx.userId, { taskId: id });
  return json({ notes });
});

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const input = await body(req, addNoteSchema);
  const note = await addNote(id, input, ctx.userId);
  if (!note) return error("Task not found", 404);
  return json({ note }, 201);
});
