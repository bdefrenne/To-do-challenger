/*
  /api/standup?from=YYYY-MM-DD&to=YYYY-MM-DD
    GET — the standup digest data for a window: notes (incl. decisions) +
          finished tasks. Defaults to the last 24h if no range is given.
*/

import { NextRequest } from "next/server";
import { route, json, type AuthedCtx } from "@/lib/api";
import { activityDigest, listNotes, resolveAssignees } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const sp = new URL(req.url).searchParams;
  const to = sp.get("to") ?? new Date().toISOString();
  const from =
    sp.get("from") ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // ?credited=<id|email|name> whose work; ?credited=team for everyone.
  // Absent => the caller's own.
  const raw = sp.get("credited") ?? sp.get("actor");
  const credited = !raw
    ? userId
    : /^(team|all|everyone|\*)$/i.test(raw.trim())
      ? null
      : (await resolveAssignees([raw]))[0] ?? "__no_such_user__";
  const [digest, notes] = await Promise.all([
    activityDigest(userId, { from, to, credited, tz: sp.get("tz") ?? undefined }),
    listNotes(userId, { from, to }),
  ]);
  return json({ ...digest, notes });
});
