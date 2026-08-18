/*
  POST /api/tasks/:id/complete — mark done (or reopen with {"done": false}).

  `{"withSubtasks": true}` closes the whole BRANCH: every unfinished descendant
  first, then this task. Without it, completing a task that still has open
  subtasks is refused with a 400 carrying `code: "open_subtasks"` — see
  `assertSubtreeDone` in db/service.ts, and the toast that offers this flag.
*/

import { NextRequest } from "next/server";
import { z } from "zod";
import { route, json, error, body, type AuthedCtx } from "@/lib/api";
import { completeTask } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  done: z.boolean().optional(),
  withSubtasks: z.boolean().optional(),
});

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const { done, withSubtasks } = await body(req, schema);
  const task = await completeTask(id, done ?? true, ctx.userId, undefined, {
    withSubtasks,
  });
  if (!task) return error("Task not found", 404);
  return json({ task });
});
