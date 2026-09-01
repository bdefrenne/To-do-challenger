/*
  /api/activity
    GET — the merged activity feed: what CHANGED on tasks (`task_logs`, every
          surface) interleaved with what agents ASKED (`mcp_calls`, every MCP
          tool invocation including the reads that change nothing).

  Query params — all optional:
    from,to     window edges (YYYY-MM-DD or ISO). Default: the last 24h.
    tz          IANA zone the bare dates mean (default Europe/Brussels).
    actor       id, email or display name — whose actions.
    source      comma-separated: ui,api,mcp,telegram.
    stream      comma-separated: task,call. Default both.
    writesOnly  "1" to drop the read-only MCP tools (the noise floor).
    text        substring of the message, or of the tool name.
    limit       max entries after the merge (default 200, cap 500).
    stats       "1" to also return per-user/per-tool call counts.
*/

import { NextRequest } from "next/server";
import { route, json, type AuthedCtx } from "@/lib/api";
import { activityFeed, mcpCallStats, resolveAssignees } from "@/lib/db/service";
import type { LogSource } from "@/lib/db/log-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCES: LogSource[] = ["ui", "api", "mcp", "telegram"];

export const GET = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const sp = new URL(req.url).searchParams;
  const to = sp.get("to") ?? undefined;
  const from =
    sp.get("from") ??
    (to ? undefined : new Date(Date.now() - 24 * 3600 * 1000).toISOString());

  // A name/email is resolved to an id here rather than in the service, the same
  // way /api/standup does it — the query layer only ever deals in ids.
  const rawActor = sp.get("actor");
  const actor = !rawActor
    ? undefined
    : ((await resolveAssignees([rawActor]))[0] ?? "__no_such_user__");

  const list = (key: string): string[] | undefined => {
    const v = sp.get(key);
    return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  };
  const sources = list("source")?.filter((s): s is LogSource =>
    (SOURCES as string[]).includes(s),
  );
  const streams = list("stream")?.filter(
    (s): s is "task" | "call" => s === "task" || s === "call",
  );

  const tz = sp.get("tz") ?? undefined;
  const opts = {
    from,
    to,
    tz,
    actor,
    ...(sources?.length ? { sources } : {}),
    ...(streams?.length ? { streams } : {}),
    writesOnly: sp.get("writesOnly") === "1",
    text: sp.get("text") ?? undefined,
    limit: Number(sp.get("limit")) || undefined,
  };

  const [entries, stats] = await Promise.all([
    activityFeed(userId, opts),
    sp.get("stats") === "1"
      ? mcpCallStats(userId, { from, to, tz })
      : Promise.resolve(undefined),
  ]);
  return json({ entries, ...(stats ? { stats } : {}) });
});
