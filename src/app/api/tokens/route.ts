/*
  /api/tokens
    GET  — list the current user's API tokens (metadata only).
    POST — mint a new token. The plaintext is returned ONCE here and
           never again; the user copies it into their `claude mcp add`.
*/

import { NextRequest } from "next/server";
import { z } from "zod";
import { route, json, body, type AuthedCtx } from "@/lib/api";
import { listTokens, createToken } from "@/lib/db/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, { userId }: AuthedCtx) => {
  return json({ tokens: await listTokens(userId) });
});

const createSchema = z.object({ label: z.string().max(120).optional() });

export const POST = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const { label } = await body(req, createSchema);
  const { plaintext, token } = await createToken(userId, label ?? "Claude");
  // `plaintext` is shown exactly once — the client must surface it now.
  return json({ token, plaintext }, 201);
});
