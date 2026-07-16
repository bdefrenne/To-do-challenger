/*
  GET /api/google/connect?scope=shared|personal
    Starts the "Connect Google" OAuth flow. Requires a logged-in user;
    signs a state blob (scope + uid) and redirects to Google's consent
    screen. Google calls us back at /api/google/callback.
*/

import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import { buildAuthUrl, signState, type ConnectionScope } from "@/lib/google/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const uid = await getUserId(req);
  if (!uid) {
    return NextResponse.redirect(new URL("/login", req.nextUrl.origin));
  }

  const scopeParam = req.nextUrl.searchParams.get("scope");
  const scope: ConnectionScope = scopeParam === "shared" ? "shared" : "personal";

  try {
    const state = signState(scope, uid, Date.now());
    const url = buildAuthUrl(req.nextUrl.origin, state);
    return NextResponse.redirect(url);
  } catch (e) {
    // Missing GOOGLE_CLIENT_ID/SECRET etc. — send back with an error flag.
    const back = new URL("/settings", req.nextUrl.origin);
    back.searchParams.set("calendar_error", (e as Error).message);
    return NextResponse.redirect(back);
  }
}
