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

/** `?flag`, `?flag=1`, `?flag=true` => true; `?flag=false|0` => false; absent
 *  => undefined (leave the filter alone). */
const boolParam = (v: string | null) =>
  v == null ? undefined : v !== "false" && v !== "0";

export const GET = route(async (req: NextRequest, { userId }) => {
  const sp = new URL(req.url).searchParams;
  const statusCsv = sp.get("status");
  // ?archived=only  → just archived tasks (the Archived view)
  // ?archived=include|all → active + archived; anything else (or absent) hides them
  const archived = sp.get("archived");
  const limit = sp.get("limit");
  const sort = sp.get("sort");
  const filter: TaskFilter = {
    boardId: sp.get("boardId") ?? undefined,
    projectId: sp.get("projectId") ?? undefined,
    status: statusCsv
      ? (statusCsv.split(",").map((s) => s.trim()).filter(Boolean) as TaskStatus[])
      : undefined,
    assignee: sp.get("assignee") ?? undefined,
    actor: sp.get("actor") ?? undefined,
    text: sp.get("text") ?? sp.get("q") ?? undefined,
    dueBefore: sp.get("dueBefore") ?? undefined,
    dueAfter: sp.get("dueAfter") ?? undefined,
    // presence => true; ?overdue=false / ?overdue=0 => false
    overdue: boolParam(sp.get("overdue")),
    archivedOnly: archived === "only",
    includeArchived: archived === "include" || archived === "all",
    includeDone: boolParam(sp.get("includeDone")),
    // Activity windows — the same axes the MCP tools expose (see taskFilterShape
    // in @/lib/api): what moved, shipped, was edited or created in a range.
    statusChangedFrom: sp.get("statusChangedFrom") ?? undefined,
    statusChangedTo: sp.get("statusChangedTo") ?? undefined,
    completedFrom: sp.get("completedFrom") ?? undefined,
    completedTo: sp.get("completedTo") ?? undefined,
    updatedFrom: sp.get("updatedFrom") ?? undefined,
    updatedTo: sp.get("updatedTo") ?? undefined,
    createdFrom: sp.get("createdFrom") ?? undefined,
    createdTo: sp.get("createdTo") ?? undefined,
    tz: sp.get("tz") ?? undefined,
    sort: sort === "recent" ? "recent" : undefined,
    limit: limit ? Number(limit) : undefined,
  };
  // Assignee and actor are stored as account ids; resolve a name/email/id.
  for (const key of ["assignee", "actor"] as const) {
    const raw = filter[key];
    if (raw) filter[key] = (await resolveAssignees([raw]))[0] ?? "__no_such_user__";
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
