/*
  /api/boards/reorder
    POST — set the order of all boards within one of the user's projects.
           Body: { projectId, orderedIds }. Positions are reassigned 1..N,
           which the sidebar and Boards view both read.
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  reorderBoardsSchema,
  type AuthedCtx,
} from "@/lib/api";
import { reorderBoards } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const { projectId, orderedIds } = await body(req, reorderBoardsSchema);
  const ok = await reorderBoards(userId, projectId, orderedIds);
  if (!ok) return error("Project not found", 404);
  return json({ ok: true });
});
