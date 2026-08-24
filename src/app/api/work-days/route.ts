/*
  /api/work-days?projectId=&day=&tz=
    GET  — the day's close-out payload: the row (with `sealed` derived), the
           day's digest, the probably-finished candidates, and the
           snapshot-vs-reality drift.
    POST — "Ready for the day": freeze the todo as it stands.

  The acting user is always the third part of a day's key and comes from the
  request, never the body — you can't draft someone else's day for them.

  A day is never created here in the sense of being *started*: `getWorkDay`
  answers for any date whether or not a row exists, because a day exists by
  virtue of work happening in it. A row appears only once one of the two
  artifacts (the snapshot, the prose) is produced.
*/

import { NextRequest } from "next/server";
import { route, json, workDayQuerySchema, type AuthedCtx } from "@/lib/api";
import { markDayReady, workDayReview } from "@/lib/db/service";
import { APP_TIMEZONE } from "@/lib/workday";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const sp = new URL(req.url).searchParams;
  // A ZodError here becomes a 422 via `route()`.
  const q = workDayQuerySchema.parse(Object.fromEntries(sp));
  return json(await workDayReview(userId, q.projectId, q.day, q.tz ?? APP_TIMEZONE));
});

export const POST = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const q = workDayQuerySchema.parse(await req.json());
  return json({ day: await markDayReady(userId, q.projectId, q.day) });
});
