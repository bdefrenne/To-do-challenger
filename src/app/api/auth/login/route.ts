/*
  POST /api/auth/login  { email, password }
  On success, sets the signed session cookie and returns the user.
  Deliberately NOT wrapped in route() — this is how you GET a session,
  so it can't require one.
*/

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyLogin } from "@/lib/db/users";
import { SESSION_COOKIE, signSession, sessionCookieOptions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Email and password are required." }, { status: 422 });
  }

  const user = await verifyLogin(parsed.data.email, parsed.data.password);
  if (!user) {
    // Same message for unknown email vs wrong password — don't leak which.
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }

  const res = NextResponse.json({ user });
  res.cookies.set(SESSION_COOKIE, signSession(user.id, Date.now()), sessionCookieOptions());
  return res;
}
