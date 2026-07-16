/*
  POST /api/tasks/:id/attachments — upload an image to a task.

  Multipart form-data (field `file`). The bytes go to Vercel Blob; we
  record the metadata + public URL via the shared service layer, scoped
  to the authenticated user.
*/

import { NextRequest } from "next/server";
import { put, del } from "@vercel/blob";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { blobAuth } from "@/lib/blob";
import { addAttachment } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Max image size — stays under Vercel's ~4.5 MB serverless body limit. */
const MAX_BYTES = 4 * 1024 * 1024;

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return error("Expected a `file` upload", 400);

  if (!file.type.startsWith("image/"))
    return error("Only image files are allowed", 415);
  if (file.size > MAX_BYTES)
    return error("Image is too large (max 4 MB)", 413);

  // Namespace by user + task so uploads never collide; random suffix keeps
  // same-named files distinct.
  const blob = await put(
    `attachments/${ctx.userId}/${id}/${file.name || "image"}`,
    file,
    { access: "public", addRandomSuffix: true, contentType: file.type, ...blobAuth() },
  );

  const attachment = await addAttachment(
    id,
    {
      filename: file.name || "image",
      mimeType: file.type,
      size: file.size,
      url: blob.url,
    },
    ctx.userId,
  );

  // Task doesn't exist / not owned — clean up the just-uploaded blob.
  if (!attachment) {
    await del(blob.url, blobAuth()).catch(() => {});
    return error("Task not found", 404);
  }

  return json({ attachment }, 201);
});
