/*
  /api/standup?from=YYYY-MM-DD&to=YYYY-MM-DD
    GET — the standup digest data for a window: notes + finished tasks +
          decisions. Defaults to the last 24h if no range is given.
*/

import { NextRequest } from "next/server";
import { route, json, type AuthedCtx } from "@/lib/api";
import { standup } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const sp = new URL(req.url).searchParams;
  const to = sp.get("to") ?? new Date().toISOString();
  const from =
    sp.get("from") ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const data = await standup(userId, from, to);
  return json({ from, to, ...data });
});
