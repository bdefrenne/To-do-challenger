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
  listTaskIds,
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
    // The revisable working fields are ~2/3 of a board payload and only a
    // task's own detail view shows them, so a list read omits them unless
    // asked (?detail=full). The workspace relies on this default — see
    // LIST_TASK_COLUMNS in the service (PLAT-403).
    includeWorkingFields: sp.get("detail") === "full",
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
  // `now` is the watermark for the client's NEXT delta read. Taken before the
  // query so a row written mid-flight is re-sent next time rather than skipped,
  // and taken from the server so client clock skew can't open a gap.
  const now = new Date().toISOString();
  // DELTA read (PLAT-403): `?since=<iso>` sends only rows touched since then,
  // plus every live id so the client can drop what was deleted. A board of 142
  // tasks is ~190 KB; a typical change is one task, and re-sending the whole
  // board on every change is what put Neon's egress at 80% of its allowance.
  const since = sp.get("since");
  if (since) {
    filter.updatedAfter = since;
    const [changed, ids] = await Promise.all([
      listTasksFlat(userId, filter),
      listTaskIds(userId, filter),
    ]);
    return json({ tasks: changed, ids, now });
  }
  const flat = sp.get("flat");
  const tasks = flat
    ? await listTasksFlat(userId, filter)
    : await listTasks(userId, filter);
  return json({ tasks, now });
});

export const POST = route(async (req: NextRequest, { userId }) => {
  const input = await body(req, createTaskSchema);
  const task = await createTask(input, userId);
  return json({ task }, 201);
});
