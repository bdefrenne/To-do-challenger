/*
  POST /api/tasks/archive-done — archive every done task at once, optionally
  scoped to a single board ({"boardId"}) or project ({"projectId"}). Each is
  cascaded to its subtree. Returns { archived: <count> }.
*/

import { NextRequest } from "next/server";
import { z } from "zod";
import { route, json, body, type AuthedCtx } from "@/lib/api";
import { archiveAllDone } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  boardId: z.string().optional(),
  projectId: z.string().optional(),
});

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const scope = await body(req, schema);
  const archived = await archiveAllDone(ctx.userId, scope);
  return json({ archived });
});
