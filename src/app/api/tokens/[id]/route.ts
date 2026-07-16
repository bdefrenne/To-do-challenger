/* DELETE /api/tokens/:id — revoke one of the current user's tokens. */

import { NextRequest } from "next/server";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { revokeToken } from "@/lib/db/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;
  const ok = await revokeToken(ctx.userId, id);
  if (!ok) return error("Token not found", 404);
  return json({ ok: true });
});
