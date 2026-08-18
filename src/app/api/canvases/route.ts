/*
  /api/canvases
    GET  — list canvases (no nodes). `?projectId=` narrows to one project's,
           which — since a project has exactly one canvas — returns 0 or 1.
    POST — create a canvas for a project.
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

export const GET = route(async (req: NextRequest) => {
  // Canvases are team-visible — everyone sees every board. (route() still
  // enforces auth; this handler just needs no user arg.)
  const projectId = req.nextUrl.searchParams.get("projectId") ?? undefined;
  const canvases = await listCanvases(projectId);
  return json({ canvases });
});

export const POST = route(async (req: NextRequest, { userId }: AuthedCtx) => {
  const { name, projectId } = await body(req, createCanvasSchema);
  const canvas = await createCanvas(userId, name, projectId);
  return json({ canvas }, 201);
});
