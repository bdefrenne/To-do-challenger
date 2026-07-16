/*
  /api/version
    GET — a tiny change-cursor for the current user's board. Clients poll
          this to ask "did anything change?" without re-fetching the whole
          task list; they only reload when the cursor moves.
*/

import { route, json } from "@/lib/api";
import { getChangeCursor } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req, { userId }) => {
  return json({ v: await getChangeCursor(userId) });
});
