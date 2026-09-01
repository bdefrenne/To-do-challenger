/*
  GET /api/tasks/hidden-count?boardId=…|projectId=… — how many tasks deleting
  that board/project would destroy WITHOUT the Trash stop: { archived, trashed }.

  Archived and trashed rows no longer BLOCK the delete (TD2-214): they're out of
  every active view, so refusing on them named tasks nobody could see anywhere on
  the board. They still go with the row cascade, so the surfaces that can ask a
  human read this first and say what is about to be destroyed.
*/

import { NextRequest } from "next/server";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { hiddenTaskCount } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, _ctx: AuthedCtx) => {
  const sp = new URL(req.url).searchParams;
  const boardId = sp.get("boardId") ?? undefined;
  const projectId = sp.get("projectId") ?? undefined;
  if (!boardId && !projectId) return error("boardId or projectId is required", 400);
  return json(await hiddenTaskCount({ boardId, projectId }));
});
