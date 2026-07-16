/*
  POST /api/boards/:id/avatar — upload a board picture.

  Multipart form-data (field `file`). The client crops to a square before
  sending; we store the bytes in Vercel Blob (same pattern as the profile
  avatar) and point the board's `image` at the public URL.
*/

import { NextRequest } from "next/server";
import { put, del } from "@vercel/blob";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { blobAuth } from "@/lib/blob";
import { getBoard, updateBoard } from "@/lib/db/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Max image size — stays under Vercel's ~4.5 MB serverless body limit. */
const MAX_BYTES = 4 * 1024 * 1024;

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const { id } = await ctx.params;

  const board = await getBoard(ctx.userId, id);
  if (!board) return error("Board not found", 404);

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return error("Expected a `file` upload", 400);

  if (!file.type.startsWith("image/"))
    return error("Only image files are allowed", 415);
  if (file.size > MAX_BYTES) return error("Image is too large (max 4 MB)", 413);

  const previous = board.image ?? null;

  const blob = await put(`boards/${id}/${file.name || "board"}`, file, {
    access: "public",
    addRandomSuffix: true,
    contentType: file.type,
    ...blobAuth(),
  });

  const updated = await updateBoard(ctx.userId, id, { image: blob.url });
  if (!updated) {
    await del(blob.url, blobAuth()).catch(() => {});
    return error("Board not found", 404);
  }

  // Best-effort cleanup of the old picture (only if it was one of ours).
  if (previous && previous.includes(".blob.vercel-storage.com"))
    await del(previous, blobAuth()).catch(() => {});

  return json({ board: updated }, 201);
});
