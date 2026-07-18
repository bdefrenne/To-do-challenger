/*
  /api/canvases
    GET  — list the user's canvases (no nodes).
    POST — create a canvas.
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  body,
  createCanvasSchema,
  type AuthedCtx,
} from "@/lib/api";
import { listCanvases, createCanvas } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  // Canvases are team-visible — everyone sees every board. (route() still
  // enforces auth; this handler just needs no request/user args.)
  const canvases = await listCanvases();
  return json({ canvases });
});

export const POST = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const { name } = await body(req, createCanvasSchema);
  const canvas = await createCanvas(userId, name);
  return json({ canvas }, 201);
});
