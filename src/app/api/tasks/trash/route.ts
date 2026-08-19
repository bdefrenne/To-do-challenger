/*
  DELETE /api/tasks/trash — EMPTY THE TRASH: every deleted task, gone for good
  (rows, logs, attachment rows, blobs). Optionally scoped to one board
  (?boardId=) or project (?projectId=). Returns { purged: <count> }.

  The irreversible half of the two-step delete — everything it drops is already
  sitting in the Trash, where someone could see and restore it.
*/

import { NextRequest } from "next/server";
import { route, json, type AuthedCtx } from "@/lib/api";
import { emptyTrash } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const sp = new URL(req.url).searchParams;
  const purged = await emptyTrash(ctx.userId, {
    boardId: sp.get("boardId") ?? undefined,
    projectId: sp.get("projectId") ?? undefined,
  });
  return json({ purged });
});
