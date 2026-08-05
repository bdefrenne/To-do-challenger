/*
  /api/notes/:id
    PATCH  — check off (resolve)/re-open a note, or move it (a sticky drag).
             Body: { resolved?: boolean, x?: number, y?: number }.
    DELETE — permanently remove a note (a sticky's "×"). No undo.
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  patchNoteSchema,
  type AuthedCtx,
} from "@/lib/api";
import { patchNote, deleteNote } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const patch = await body(req, patchNoteSchema);
  const note = await patchNote(id, patch);
  if (!note) return error("Note not found", 404);
  return json({ note });
});

export const DELETE = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const ok = await deleteNote(id);
  if (!ok) return error("Note not found", 404);
  return json({ ok });
});
