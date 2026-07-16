/*
  PATCH /api/profile — edit your own profile (display name, avatar color,
  and/or profile-picture URL). Partial: send just the fields you're changing.
  `avatarUrl: null` clears the picture (back to initials).
*/

import { NextRequest } from "next/server";
import { route, json, error, body, profileSchema, type AuthedCtx } from "@/lib/api";
import { updateUserProfile } from "@/lib/db/users";

export const PATCH = route(async (req: NextRequest, ctx: AuthedCtx) => {
  const patch = await body(req, profileSchema);
  const user = await updateUserProfile(ctx.userId, patch);
  if (!user) return error("User not found", 404);
  return json({ user });
});
