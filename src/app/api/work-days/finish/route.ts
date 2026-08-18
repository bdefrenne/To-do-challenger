/*
  POST /api/work-days/finish
    "Finish work" — the day is drafted and ready to present. Records the two
    authored fields (`bullets`, `summary`) and stamps `drafted_at`.

  It completes nothing. Each task the close-out proposes goes through
  `complete_task` on its own, so the flow batches the asking, never the deciding.

  Refuses a SEALED day (one where a later day has already been drafted) — at that
  distance a late completion belongs to the current day, labelled as clearing
  older work, rather than silently rewriting a standup already presented.
*/

import { NextRequest } from "next/server";
import { route, json, finishWorkSchema, type AuthedCtx } from "@/lib/api";
import { finishWork } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const input = finishWorkSchema.parse(await req.json());
  return json({
    day: await finishWork(userId, input.projectId, input.day, {
      bullets: input.bullets,
      summary: input.summary,
    }),
  });
});
