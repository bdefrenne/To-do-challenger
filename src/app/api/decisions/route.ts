/*
  /api/decisions
    GET — decisions across ALL the user's tasks, with optional filters
          (?category, ?boardId, ?projectId, ?unreviewed, ?from, ?to, ?taskId).
          Powers the Decisions page + retros.
*/

import { NextRequest } from "next/server";
import { route, json, type AuthedCtx } from "@/lib/api";
import { listDecisions, type DecisionFilter } from "@/lib/db/service";
import type { DecisionCategory } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const sp = new URL(req.url).searchParams;
  const unreviewed = sp.get("unreviewed");
  const filter: DecisionFilter = {
    taskId: sp.get("taskId") ?? undefined,
    category: (sp.get("category") as DecisionCategory | null) ?? undefined,
    boardId: sp.get("boardId") ?? undefined,
    projectId: sp.get("projectId") ?? undefined,
    unreviewed:
      unreviewed == null ? undefined : unreviewed !== "false" && unreviewed !== "0",
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
  };
  const decisions = await listDecisions(userId, filter);
  return json({ count: decisions.length, decisions });
});
