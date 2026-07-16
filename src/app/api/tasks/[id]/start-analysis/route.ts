/*
  /api/tasks/:id/start-analysis
    POST — enter the ANALYSIS phase: lock the code, stamp analysisStartedAt
           (set-if-null), log an attributed `started` entry, and return the task
           plus a ready-to-paste "analyze this" prompt for the Copy button.
           Idempotent — a second click just re-returns the prompt.
*/

import { NextRequest } from "next/server";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { startAnalysis } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Clipboard prompt for the analysis phase. Slim by design: it points the AI at
 * the phase-entry tool (`get_task_for_analysis`) — calling it is what loads the
 * full context AND records the start — then defers to the canonical workflow
 * contract rather than restating it, so it can't drift.
 */
function analysisPrompt(code: string, title: string): string {
  return (
    `I want you to ANALYZE task ${code} — "${title}" using the "todo" MCP.\n\n` +
    `Call get_task_for_analysis to load the full context (this records that ` +
    `analysis has started and locks the code). Then follow the todo workflow ` +
    `contract — it's in the MCP server instructions and the todo://workflow ` +
    `resource. In short: record_decision for each choice as it happens, and when ` +
    `analysis is settled write analysisSummary and set analyzedAt. When we move ` +
    `to building, call get_task_for_working.`
  );
}

export const POST = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const result = await startAnalysis(id, ctx.userId, "You");
  if (!result) return error("Task not found", 404);
  const { task } = result;
  const prompt = analysisPrompt(task.code ?? task.ref ?? id, task.title);
  return json({ task, prompt });
});
