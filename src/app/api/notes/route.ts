/*
  /api/notes
    GET — team notes across ALL the user's tasks (?type, ?from, ?to, ?taskId,
          ?includeResolved). Open notes only unless includeResolved=true.
          Powers the Notes page + standup.
*/

import { NextRequest } from "next/server";
import { route, json, type AuthedCtx } from "@/lib/api";
import { listNotes, type NoteFilter } from "@/lib/db/service";
import type { NoteType } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const sp = new URL(req.url).searchParams;
  const filter: NoteFilter = {
    taskId: sp.get("taskId") ?? undefined,
    type: (sp.get("type") as NoteType | null) ?? undefined,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    includeResolved: sp.get("includeResolved") === "true",
  };
  const notes = await listNotes(userId, filter);
  return json({ count: notes.length, notes });
});
