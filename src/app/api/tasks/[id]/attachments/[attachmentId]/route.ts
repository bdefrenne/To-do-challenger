/*
  DELETE /api/tasks/:id/attachments/:attachmentId — remove an image from
  a task (deletes the Blob object + the row), scoped to the current user.
*/

import { NextRequest } from "next/server";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { deleteAttachment } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = route(async (_req: NextRequest, ctx: AuthedCtx) => {
  const { attachmentId } = await ctx.params;
  const ok = await deleteAttachment(attachmentId, ctx.userId);
  if (!ok) return error("Attachment not found", 404);
  return json({ ok: true });
});
