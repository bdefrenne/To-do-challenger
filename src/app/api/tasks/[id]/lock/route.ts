/*
  /api/tasks/:id/lock
    POST — lock (freeze) the task's code and return it plus a ready-to-paste
           "work on this" prompt for the Copy-prompt button. Idempotent.
*/

import { NextRequest } from "next/server";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { mintRef } from "@/lib/db/service";
import { workPrompt } from "@/lib/prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const task = await mintRef(id, ctx.userId);
  if (!task) return error("Task not found", 404);
  const prompt = workPrompt(task.code ?? task.ref ?? id, task.title);
  return json({ task, prompt });
});
