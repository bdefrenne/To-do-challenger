/*
  POST /api/tasks/:id/prompt — return a ready-to-paste handoff prompt for the
  task, by kind. Every kind locks (mints) the code first: the analyze handoff
  (To Do → Analyzing) is the first commitment, so it freezes the code too, and
  every prompt cites a stable ref. Idempotent.
*/

import { NextRequest } from "next/server";
import { z } from "zod";
import { route, json, error, body, type AuthedCtx } from "@/lib/api";
import { mintRef } from "@/lib/db/service";
import { analyzePrompt, workPrompt, analyzeThenWorkPrompt } from "@/lib/prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  kind: z.enum(["analyze", "work", "analyze-work"]),
});

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const { kind } = await body(req, schema);

  // Every handoff — analyze included — is a commitment, so lock the code up
  // front (idempotent). The ref is then stable to cite in the prompt + commits.
  const task = await mintRef(id, ctx.userId);
  if (!task) return error("Task not found", 404);

  const code = task.code ?? task.ref ?? id;
  const prompt =
    kind === "analyze"
      ? analyzePrompt(code, task.title)
      : kind === "work"
        ? workPrompt(code, task.title)
        : analyzeThenWorkPrompt(code, task.title);

  return json({ task, prompt });
});
