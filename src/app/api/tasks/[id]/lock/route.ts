/*
  /api/tasks/:id/lock
    POST — lock (freeze) the task's code and return it plus a ready-to-paste
           "work on this" prompt for the Copy-prompt button. Idempotent.
*/

import { NextRequest } from "next/server";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { mintRef } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The clipboard prompt — a slim handoff that points at the canonical workflow
 * contract (MCP server instructions / the todo://workflow resource) rather than
 * restating it, so it can't drift from the source of truth. Kept self-sufficient
 * for a client that has only the todo tools connected.
 */
function workPrompt(code: string, title: string): string {
  return (
    `I want you to work on task ${code} — "${title}" using the "todo" MCP.\n\n` +
    `Start with get_task to load full context, and follow the todo workflow ` +
    `contract — it's in the MCP server instructions and the todo://workflow ` +
    `resource (read it if you haven't). In short: reference ${code} in every ` +
    `commit and link_commit each sha, add_note for important decisions or ` +
    `standup-worthy updates (when I ask), and run the finish protocol (reconcile ` +
    `the git diff, write the summary from what shipped, mark done) when we're done.`
  );
}

export const POST = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const task = await mintRef(id, ctx.userId);
  if (!task) return error("Task not found", 404);
  const prompt = workPrompt(task.code ?? task.ref ?? id, task.title);
  return json({ task, prompt });
});
