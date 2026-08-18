/*
  POST /api/work-days/log-past
    Log work that never reached the board — a phone call, a conversation, an
    errand. Creates a real task, already done, credited to the working day it
    actually happened on.

  A real task rather than a separate day-log entry, so there is ONE record of what
  you did: searchable a year later, and consistent with the board being the record
  rather than a partial view of it. It's filed straight into DONE THIS WEEK, so it
  never sits in a triage lane asking to be worked.
*/

import { NextRequest } from "next/server";
import { route, json, logPastWorkSchema, type AuthedCtx } from "@/lib/api";
import { logPastWork } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const input = logPastWorkSchema.parse(await req.json());
  return json({ task: await logPastWork(userId, input) });
});
