/*
  /api/notes/:id
    PATCH — check off (resolve) or re-open a note. Body: { resolved: boolean }.
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  resolveNoteSchema,
  type AuthedCtx,
} from "@/lib/api";
import { resolveNote } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const { resolved } = await body(req, resolveNoteSchema);
  const note = await resolveNote(id, resolved, ctx.userId);
  if (!note) return error("Note not found", 404);
  return json({ note });
});
