/*
  /api/tasks/:id/start-work
    POST — enter the WORK phase: stamp workStartedAt (set-if-null), log an
           attributed `started` entry, and return the task plus a ready-to-paste
           "build this" prompt for the Copy button. Idempotent.
*/

import { NextRequest } from "next/server";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { startWork } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Clipboard prompt for the work phase. Points the AI at `get_task_for_working`
 * — calling it loads the build context AND records that work has started — then
 * defers to the canonical workflow contract.
 */
function workPrompt(code: string, title: string): string {
  return (
    `I want you to BUILD task ${code} — "${title}" using the "todo" MCP.\n\n` +
    `Call get_task_for_working to load the build context (this records that work ` +
    `has started). Then implement, following the todo workflow contract (MCP ` +
    `server instructions / todo://workflow resource): reference ${code} in every ` +
    `commit and link_commit each sha, log anything added on the fly as a scope ` +
    `decision, and run the finish protocol (reconcile the git diff, write the ` +
    `summary from what shipped, mark done) when we're done.`
  );
}

export const POST = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const result = await startWork(id, ctx.userId, "You");
  if (!result) return error("Task not found", 404);
  const { task } = result;
  const prompt = workPrompt(task.code ?? task.ref ?? id, task.title);
  return json({ task, prompt });
});
