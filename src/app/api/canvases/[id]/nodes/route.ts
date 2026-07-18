/*
  /api/canvases/[id]/nodes
    PUT — batch save: upsert some nodes, delete others. The canvas editor's
          single debounced write. Returns the refreshed canvas (with nodes).
*/

import { NextRequest } from "next/server";
import {
  route,
  json,
  error,
  body,
  saveCanvasNodesSchema,
  type AuthedCtx,
} from "@/lib/api";
import { saveCanvasNodes, type CanvasNodeInput } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = route(async (req: NextRequest, { userId, params }: AuthedCtx) => {
  const { id } = await params;
  const { upserts, deletes } = await body(req, saveCanvasNodesSchema);
  const canvas = await saveCanvasNodes(userId, id, {
    upserts: upserts as CanvasNodeInput[] | undefined,
    deletes,
  });
  if (!canvas) return error("Canvas not found", 404);
  return json({ canvas });
});
