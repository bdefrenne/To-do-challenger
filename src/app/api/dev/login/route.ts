/*
  DEV SIGN-IN (TD2-212) — password-free session minting, development only.

    GET  /api/dev/login              → { users, database } for the picker
    GET  /api/dev/login?as=<email|id> → signs in, 303 to /   (browser/agent)
    GET  /api/dev/login?as=…&next=/activity → …and lands there
    POST /api/dev/login  { userId | email } → signs in, returns { user }

  Why it exists: an agent working in this repo could verify the API, the
  migration and the build of a page and still never LOOK at it, because
  there is no way in without a password. Every UI change shipped unseen.

  The fence is the whole security model — see `devLoginEnabled()` in
  src/lib/dev-login.ts, which is the only thing that decides. Both
  handlers open with it and answer 404 when it's shut, so a fenced
  deployment is indistinguishable from one that never had this route.

  Deliberately NOT wrapped in route(): like /api/auth/login, this is how
  you GET a session, so it cannot require one.
*/

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { devLoginEnabled } from "@/lib/dev-login";
import { getUserByEmail, getUserById, listUsers, type PublicUser } from "@/lib/db/users";
import { SESSION_COOKIE, signSession, sessionCookieOptions } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What a fenced request sees: nothing at all. */
const notFound = () => new NextResponse(null, { status: 404 });

/**
 * Which database this dev server is pointed at, host + name only — never
 * the credentials. Shown in the picker because dev here shares Postgres
 * with production (TD2-212): clicking around IS editing the live board,
 * and that should be on screen rather than in someone's memory.
 */
function databaseLabel(): string | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.split(".")[0]; // ep-orange-cake-…-pooler
    const name = u.pathname.replace(/^\//, "") || "?";
    return `${name} @ ${host}`;
  } catch {
    return null;
  }
}

/**
 * Where ?as= sends the browser afterwards. Same-origin relative paths only:
 * a leading "/" but not "//" (which a browser reads as protocol-relative, i.e.
 * another host). Even fenced to development, a redirect that accepts an
 * arbitrary destination is a habit worth not forming.
 *
 * It earns its keep for screenshots: headless Chrome visits ONE url per run,
 * so without this an agent cannot sign in AND reach the page it needs to look
 * at in the same invocation — which was the point of TD2-212.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/";
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

/** Resolve a handle that may be either a user id or an email address. */
async function resolveUser(handle: string): Promise<PublicUser | null> {
  const h = handle.trim();
  if (!h) return null;
  return h.includes("@") ? getUserByEmail(h) : getUserById(h);
}

/** Attach the same signed session cookie a real login would set. */
function withSession<T extends NextResponse>(res: T, userId: string): T {
  res.cookies.set(SESSION_COOKIE, signSession(userId, Date.now()), sessionCookieOptions());
  return res;
}

export async function GET(req: NextRequest) {
  if (!devLoginEnabled()) return notFound();

  const as = req.nextUrl.searchParams.get("as");
  if (as) {
    const user = await resolveUser(as);
    if (!user) return NextResponse.json({ error: "No such user." }, { status: 404 });
    // 303 so the browser follows with GET regardless of how it got here.
    const dest = safeNext(req.nextUrl.searchParams.get("next"));
    return withSession(
      NextResponse.redirect(new URL(dest, req.nextUrl.origin), 303),
      user.id,
    );
  }

  return NextResponse.json({ users: await listUsers(), database: databaseLabel() });
}

const schema = z.object({
  userId: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
});

export async function POST(req: NextRequest) {
  if (!devLoginEnabled()) return notFound();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = schema.safeParse(body);
  const handle = parsed.success ? (parsed.data.userId ?? parsed.data.email) : undefined;
  if (!handle) {
    return NextResponse.json({ error: "Pass a userId or an email." }, { status: 422 });
  }

  const user = await resolveUser(handle);
  if (!user) return NextResponse.json({ error: "No such user." }, { status: 404 });

  return withSession(NextResponse.json({ user }), user.id);
}
