/*
  /api/liveblocks-auth
    POST — authorize the current user into a canvas room. Called by the
    Liveblocks client (LiveblocksProvider authEndpoint). We reuse the app's
    own session (requireUser), then attach the user's name + color so their
    live cursor is labelled. Canvases are team-visible here, so any signed-in
    user gets FULL_ACCESS to every `canvas:*` room.
*/

import { NextRequest } from "next/server";
import { Liveblocks } from "@liveblocks/node";
import { requireUser, AuthError } from "@/lib/auth";
import { getUserById } from "@/lib/db/users";
import { error } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.LIVEBLOCKS_SECRET_KEY;
  if (!secret) return error("Liveblocks is not configured", 501);

  let userId: string;
  try {
    userId = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthError) return error(e.message, e.status);
    throw e;
  }

  const user = await getUserById(userId);
  if (!user) return error("User not found", 404);

  const liveblocks = new Liveblocks({ secret });
  const session = liveblocks.prepareSession(userId, {
    userInfo: { name: user.name || user.email, color: user.color },
  });
  // Whole-team access: any signed-in user may edit any canvas room.
  session.allow("canvas:*", session.FULL_ACCESS);

  const { status, body } = await session.authorize();
  return new Response(body, { status });
}
