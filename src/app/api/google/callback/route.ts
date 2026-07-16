/*
  GET /api/google/callback?code=...&state=...
    Google redirects here after consent. We verify the signed state (and
    that it belongs to the currently logged-in user), exchange the code for
    tokens, look up the account email, persist the connection, and bounce
    back to Settings.
*/

import { NextRequest, NextResponse } from "next/server";
import { getUserId } from "@/lib/auth";
import { exchangeCode, fetchUserEmail, verifyState } from "@/lib/google/oauth";
import { saveConnection } from "@/lib/google/connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function backToSettings(req: NextRequest, params: Record<string, string>) {
  const url = new URL("/settings", req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  // The user denied consent, or Google returned an error.
  const oauthError = sp.get("error");
  if (oauthError) return backToSettings(req, { calendar_error: oauthError });

  const code = sp.get("code");
  const state = verifyState(sp.get("state") ?? undefined, Date.now());
  if (!code || !state) {
    return backToSettings(req, { calendar_error: "Invalid or expired OAuth state." });
  }

  // Tie the callback to the logged-in session (CSRF): the session cookie is
  // sent on this top-level GET, so the state's uid must match it.
  const uid = await getUserId(req);
  if (!uid || uid !== state.uid) {
    return backToSettings(req, { calendar_error: "Sign in and connect again." });
  }

  try {
    const tokens = await exchangeCode(code, req.nextUrl.origin);
    const googleEmail = await fetchUserEmail(tokens.accessToken);
    await saveConnection({ scope: state.scope, userId: uid, googleEmail, tokens });
    return backToSettings(req, { calendar_connected: state.scope });
  } catch (e) {
    return backToSettings(req, { calendar_error: (e as Error).message });
  }
}
