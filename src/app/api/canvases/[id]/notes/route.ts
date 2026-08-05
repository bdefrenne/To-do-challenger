/*
  /api/canvases/:id/notes
    GET  — this canvas's stickies (open + resolved — resolved ones stay
           visible, dimmed, until deleted or checked off elsewhere).
    POST — drop a sticky at { note, x, y, type?, tags?, taskHandle? }.
           taskHandle optionally ALSO links it to a task.
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  addCanvasNoteSchema,
  type AuthedCtx,
} from "@/lib/api";
import { addCanvasNote, listNotes } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const notes = await listNotes(ctx.userId, { canvasId: id, includeResolved: true });
  return json({ notes });
});

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const { note, type, tags, x, y, taskHandle } = await body(req, addCanvasNoteSchema);
  const created = await addCanvasNote(
    id,
    x,
    y,
    { note, type, tags },
    ctx.userId,
    undefined,
    taskHandle,
  );
  if (!created) return error("Canvas not found (or taskHandle didn't resolve)", 404);
  return json({ note: created }, 201);
});
