/*
  POST /api/canvases/:id/images — upload a pasted/dropped image for a canvas.

  Multipart form-data (field `file`). The bytes go straight to Vercel Blob and
  we return the public URL; unlike task attachments there's no DB row — the URL
  lives on the canvas `image` node's `data.url` and persists via the canvas save
  loop. The client downscales/re-encodes before sending, so this is mostly a
  thin blob writer (the size/type checks are a backstop).
*/

import { NextRequest } from "next/server";
import { put } from "@vercel/blob";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { blobAuth } from "@/lib/blob";

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
  if (file.size > MAX_BYTES) return error("Image is too large (max 4 MB)", 413);

  // Namespace by user + canvas so uploads never collide; random suffix keeps
  // same-named files distinct.
  const blob = await put(
    `canvas/${ctx.userId}/${id}/${file.name || "image"}`,
    file,
    { access: "public", addRandomSuffix: true, contentType: file.type, ...blobAuth() },
  );

  return json({ url: blob.url }, 201);
});
