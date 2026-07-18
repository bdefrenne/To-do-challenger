/*
  /api/canvases/[id]
    GET    — one canvas with all its nodes.
    PATCH  — rename and/or persist the viewport (pan/zoom).
    DELETE — remove the canvas (cascades to its nodes).
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  updateCanvasSchema,
  type AuthedCtx,
} from "@/lib/api";
import { getCanvas, updateCanvas, deleteCanvas } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest, { params }: AuthedCtx) => {
  const { id } = await params;
  const canvas = await getCanvas(id);
  if (!canvas) return error("Canvas not found", 404);
  return json({ canvas });
});

export const PATCH = route(async (req: NextRequest, { params }: AuthedCtx) => {
  const { id } = await params;
  const patch = await body(req, updateCanvasSchema);
  const canvas = await updateCanvas(id, patch);
  if (!canvas) return error("Canvas not found", 404);
  return json({ canvas });
});

export const DELETE = route(async (_req: NextRequest, { params }: AuthedCtx) => {
  const { id } = await params;
  const ok = await deleteCanvas(id);
  if (!ok) return error("Canvas not found", 404);
  return json({ ok });
});
