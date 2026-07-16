/*
  /api/tasks/:id/decisions
    GET  — decisions recorded on this task
    POST — record a decision (auto-starts the analysis clock)
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  recordDecisionSchema,
  type AuthedCtx,
} from "@/lib/api";
import { listDecisions, recordDecision } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const decisions = await listDecisions(ctx.userId, { taskId: id });
  return json({ decisions });
});

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const input = await body(req, recordDecisionSchema);
  const decision = await recordDecision(id, input, ctx.userId);
  if (!decision) return error("Task not found", 404);
  return json({ decision }, 201);
});
