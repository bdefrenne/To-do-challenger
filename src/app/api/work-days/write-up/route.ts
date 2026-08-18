/*
  GET /api/work-days/write-up?projectId=&day=&userId=
    One person's standup for one working day, in FULL.

  Its own route because ranged reads deliberately don't carry it: `listCompletions`
  ships a one-line `previewOf` teaser per (person, day), since a Done view spans
  four weeks × a whole team and authored prose in a collection read is what put the
  egress bill at 80% of its allowance (PLAT-403, and see `LIST_TASK_COLUMNS`). This
  is the read for the one column someone actually opens.

  `getWorkDay` unchanged: it already takes the day's OWNER as its first argument
  and already derives `sealed`, so reading a teammate's day needs no new service
  code — and `sealed` comes along, which is what lets the reader see that a
  write-up is still a correctable draft.
*/

import { NextRequest } from "next/server";
import { route, json, writeUpQuerySchema } from "@/lib/api";
import { getWorkDay } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* No `AuthedCtx`: `route()` has already established there IS a session, and
   whose day to read comes from the query, not from who is asking. */
export const GET = route(async (req: NextRequest) => {
  const sp = new URL(req.url).searchParams;
  // A ZodError here becomes a 422 via `route()`.
  const q = writeUpQuerySchema.parse(Object.fromEntries(sp));
  const day = await getWorkDay(q.userId, q.projectId, q.day);
  // Only the three fields a reader needs — the snapshot stays in Postgres.
  return json({
    summary: day.summary,
    bullets: day.bullets,
    sealed: day.sealed,
  });
});
