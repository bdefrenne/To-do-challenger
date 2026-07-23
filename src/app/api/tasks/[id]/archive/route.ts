/*
  POST /api/tasks/:id/archive — archive a done task (or un-archive with
  {"archived": false}). Only done tasks can be archived; the service returns a
  400 otherwise.
*/

import { NextRequest } from "next/server";
import { z } from "zod";
import { route, json, error, body, type AuthedCtx } from "@/lib/api";
import { archiveTask } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ archived: z.boolean().optional() });

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const { archived } = await body(req, schema);
  const task = await archiveTask(id, archived ?? true, ctx.userId);
  if (!task) return error("Task not found", 404);
  return json({ task });
});
