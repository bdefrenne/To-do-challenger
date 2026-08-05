/*
  /api/standup?from=YYYY-MM-DD&to=YYYY-MM-DD
    GET — the standup digest data for a window: notes (incl. decisions) +
          finished tasks. Defaults to the last 24h if no range is given.
*/

import { NextRequest } from "next/server";
import { route, json, type AuthedCtx } from "@/lib/api";
import { standup, resolveAssignees } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const sp = new URL(req.url).searchParams;
  const to = sp.get("to") ?? new Date().toISOString();
  const from =
    sp.get("from") ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // ?actor=<id|email|name> whose finished work; ?actor=team for everyone.
  // Absent => the caller's own (standup's default).
  const raw = sp.get("actor");
  const actor = !raw
    ? undefined
    : /^(team|all|everyone|\*)$/i.test(raw.trim())
      ? null
      : (await resolveAssignees([raw]))[0] ?? "__no_such_user__";
  const data = await standup(userId, from, to, actor);
  return json({ from, to, actor: actor === null ? "team" : (actor ?? userId), ...data });
});
