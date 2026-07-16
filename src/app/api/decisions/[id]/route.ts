/*
  /api/decisions/:id
    PATCH — record a retro verdict on a decision (outcome + note).
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  reviewDecisionSchema,
  type AuthedCtx,
} from "@/lib/api";
import { reviewDecision } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PATCH = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const input = await body(req, reviewDecisionSchema);
  const decision = await reviewDecision(id, input, ctx.userId);
  if (!decision) return error("Decision not found", 404);
  return json({ decision });
});
