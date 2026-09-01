/*
  /api/boards/:id
    PATCH  — rename the board, or hide/show it (`hidden`).
    DELETE — remove the board (cascades to its tasks and their logs).
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  updateBoardSchema,
  type AuthedCtx,
} from "@/lib/api";
import { updateBoard, deleteBoard } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const patch = await body(req, updateBoardSchema);
  const board = await updateBoard(ctx.userId, id, patch);
  if (!board) return error("Board not found", 404);
  return json({ board });
});

export const DELETE = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const ok = await deleteBoard(ctx.userId, id);
  if (!ok) return error("Board not found", 404);
  return json({ ok: true });
});
