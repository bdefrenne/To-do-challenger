/*
  GET /api/calendar/connections
    The team-wide roster of connected calendars (shared + every user's
    personal). Secret-free — used by Settings, the calendar legend/filter,
    and the "which calendar?" picker on the create form.
*/

import { route, json, type AuthedCtx } from "@/lib/api";
import { listPublicConnections } from "@/lib/google/connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req, { userId }: AuthedCtx) => {
  return json({ connections: await listPublicConnections(userId) });
});
