/*
  /api/boards
    POST — create a board inside one of the user's projects.
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  createBoardSchema,
  type AuthedCtx,
} from "@/lib/api";
import { createBoard } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const { projectId, name } = await body(req, createBoardSchema);
  const board = await createBoard(userId, projectId, name);
  if (!board) return error("Project not found", 404);
  return json({ board }, 201);
});
