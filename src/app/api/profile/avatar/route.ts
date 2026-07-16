/*
  POST /api/profile/avatar — upload a profile picture.

  Multipart form-data (field `file`). The client crops to a square before
  sending; we just store the bytes in Vercel Blob (reusing the same pattern
  as task attachments) and point the user's avatarUrl at the public URL.
*/

import { NextRequest } from "next/server";
import { put, del } from "@vercel/blob";
import { route, json, error, type AuthedCtx } from "@/lib/api";
import { blobAuth } from "@/lib/blob";
import { getUserById, updateUserProfile } from "@/lib/db/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Max image size — stays under Vercel's ~4.5 MB serverless body limit. */
const MAX_BYTES = 4 * 1024 * 1024;

export const POST = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return error("Expected a `file` upload", 400);

  if (!file.type.startsWith("image/"))
    return error("Only image files are allowed", 415);
  if (file.size > MAX_BYTES) return error("Image is too large (max 4 MB)", 413);

  const previous = (await getUserById(ctx.userId))?.avatarUrl ?? null;

  const blob = await put(`avatars/${ctx.userId}/${file.name || "avatar"}`, file, {
    access: "public",
    addRandomSuffix: true,
    contentType: file.type,
    ...blobAuth(),
  });

  const user = await updateUserProfile(ctx.userId, { avatarUrl: blob.url });
  if (!user) {
    await del(blob.url, blobAuth()).catch(() => {});
    return error("User not found", 404);
  }

  // Best-effort cleanup of the old picture (only if it was one of ours).
  if (previous && previous.includes(".blob.vercel-storage.com"))
    await del(previous, blobAuth()).catch(() => {});

  return json({ user }, 201);
});
