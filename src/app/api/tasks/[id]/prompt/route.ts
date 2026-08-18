/*
  POST /api/tasks/:id/prompt — return a ready-to-paste handoff prompt for the
  task, by kind. Every kind locks (mints) the code first: the analyze handoff
  (To Do → Analyzing) is the first commitment, so it freezes the code too, and
  every prompt cites a stable ref. Idempotent.

  The web UI no longer waits on this — its copy buttons build the same string
  client-side from `lib/prompts` and fire the lock separately (POST .../lock),
  so the clipboard fills on the click itself. This stays for API clients that
  want the prompt and the lock in one call.
*/

import { NextRequest } from "next/server";
import { z } from "zod";
import { route, json, error, body, type AuthedCtx } from "@/lib/api";
import { mintRef } from "@/lib/db/service";
import { getUserById } from "@/lib/db/users";
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

  const lang = (await getUserById(ctx.userId))?.language;
  const code = task.code ?? task.ref ?? id;
  const prompt =
    kind === "analyze"
      ? analyzePrompt(code, task.title, lang)
      : kind === "work"
        ? workPrompt(code, task.title, lang)
        : analyzeThenWorkPrompt(code, task.title, lang);

  return json({ task, prompt });
});
