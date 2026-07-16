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
} from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { userId }) => {
  const url = new URL(req.url);
  const filter = {
    boardId: url.searchParams.get("boardId") ?? undefined,
    projectId: url.searchParams.get("projectId") ?? undefined,
  };
  if (url.searchParams.get("format") === "markdown") {
    const md = toMarkdown(await listTasks(userId, filter));
    return new NextResponse(md, {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }
  const flat = url.searchParams.get("flat");
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
