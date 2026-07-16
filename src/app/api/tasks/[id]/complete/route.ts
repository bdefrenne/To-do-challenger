/*
  POST /api/tasks/:id/complete — mark done (or reopen with {"done": false}).
*/

import { NextRequest } from "next/server";
import { z } from "zod";
import { route, json, error, body, type AuthedCtx } from "@/lib/api";
import { completeTask } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ done: z.boolean().optional() });

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const { done } = await body(req, schema);
  const task = await completeTask(id, done ?? true, ctx.userId);
  if (!task) return error("Task not found", 404);
  return json({ task });
});
