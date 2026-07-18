/*
  /api/tasks
    GET  — list all tasks (nested tree). ?flat=1 for a flat list,
           ?format=markdown for an AI-skimmable board.
    POST — create a task.
*/

import { NextRequest, NextResponse } from "next/server";
import {
  route,
  json,
  body,
  createTaskSchema,
} from "@/lib/api";
import {
  listTasks,
  listTasksFlat,
  createTask,
  toMarkdown,
  userNameMap,
  resolveAssignees,
  type TaskFilter,
} from "@/lib/db/service";
import type { TaskStatus } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { userId }) => {
  const sp = new URL(req.url).searchParams;
  const statusCsv = sp.get("status");
  const overdue = sp.get("overdue");
  const filter: TaskFilter = {
    boardId: sp.get("boardId") ?? undefined,
    projectId: sp.get("projectId") ?? undefined,
    status: statusCsv
      ? (statusCsv.split(",").map((s) => s.trim()).filter(Boolean) as TaskStatus[])
      : undefined,
    assignee: sp.get("assignee") ?? undefined,
    text: sp.get("text") ?? sp.get("q") ?? undefined,
    dueBefore: sp.get("dueBefore") ?? undefined,
    dueAfter: sp.get("dueAfter") ?? undefined,
    // presence => true; ?overdue=false / ?overdue=0 => false
    overdue: overdue == null ? undefined : overdue !== "false" && overdue !== "0",
  };
  // Assignees are stored as account ids; resolve a name/email/id filter to an id.
  if (filter.assignee) {
    filter.assignee = (await resolveAssignees([filter.assignee]))[0] ?? "__no_such_user__";
  }
  if (sp.get("format") === "markdown") {
    const md = toMarkdown(await listTasks(userId, filter), await userNameMap());
    return new NextResponse(md, {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }
  const flat = sp.get("flat");
  const tasks = flat
    ? await listTasksFlat(userId, filter)
    : await listTasks(userId, filter);
  return json({ tasks });
});

export const POST = route(async (req: NextRequest, { userId }) => {
  const input = await body(req, createTaskSchema);
  const task = await createTask(input, userId);
  return json({ task }, 201);
});
