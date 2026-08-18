/*
  GET /api/tasks/done?from=&to=&projectId=&boardId=&creditedTo=&tz=&limit=

  The Done view's log: everything that reached `done` in the window, one entry
  per (task, credited person, day). Archived-but-done tasks are included, and so
  are tasks since reopened — this is a record of completions, not of current
  state (see `listCompletions`).

  Its own route rather than a mode on /api/tasks, whose `{tasks, ids, now}`
  payload is keyed by task id by every consumer (the delta read reconciles
  deletions from it) — here the same task can legitimately appear more than once.
  No `since` delta either: a historical chunk is refetched whole or not at all.
*/

import { NextRequest } from "next/server";
import { route, json, completionsQuerySchema, type AuthedCtx } from "@/lib/api";
import { listCompletions, resolveAssignees } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const sp = new URL(req.url).searchParams;
  // A ZodError here becomes a 422 via `route()` — no hand-rolled param plumbing.
  const q = completionsQuerySchema.parse(Object.fromEntries(sp));
  // `credited_to` holds account ids; accept a name/email/id like /api/tasks.
  const creditedTo = q.creditedTo
    ? ((await resolveAssignees([q.creditedTo]))[0] ?? "__no_such_user__")
    : undefined;
  return json(await listCompletions(userId, { ...q, creditedTo }));
});
