/*
  POST /api/tasks/bulk — reorganize many tasks in one call.
    { ids, patch }      → same patch to every task (one SQL statement).
    { operations: [...] } → ordered heterogeneous ops, per-op results.
  Fewer round trips, coherent multi-edit. Same service layer as everything else.
*/

import { NextRequest } from "next/server";
import { route, json, body, bulkRequestSchema, type AuthedCtx } from "@/lib/api";
import { bulkUpdate, bulkApply } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const input = await body(req, bulkRequestSchema);
  if ("operations" in input) {
    return json(await bulkApply(userId, input.operations));
  }
  return json(await bulkUpdate(userId, input.ids, input.patch));
});
