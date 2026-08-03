/*
  ====================================================================
  AUTH — resolve WHO is making a request, so every read/write can be
  scoped to that user's own tasks.

  Two credential types, one door:
    • Web UI      — a signed session cookie (set at login).
    • AI / script — a per-user bearer token (Authorization: Bearer …),
                    which is how a user connects their OWN Claude.

  requireUser() returns the user id or throws AuthError (401).
  ====================================================================
*/

import { SESSION_COOKIE, verifySession } from "./session";
import { resolveToken } from "./db/users";

export class AuthError extends Error {
  status = 401 as const;
}

/** Read a named cookie out of a standard Request's Cookie header. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Pull the bearer token out of the Authorization header, if present. */
function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** How a request authenticated: a browser session (web UI) or a bearer token
 *  (an AI/script hitting the REST API). Drives activity-log surface attribution. */
export type AuthVia = "session" | "token";

/**
 * Resolve the current user from a request, plus HOW they authenticated, or
 * null if unauthenticated. Session cookie wins (web UI); otherwise a bearer
 * token (AI/script).
 */
export async function getAuth(
  req: Request,
): Promise<{ userId: string; via: AuthVia } | null> {
  const cookie = readCookie(req, SESSION_COOKIE);
  const uid = verifySession(cookie, Date.now());
  if (uid) return { userId: uid, via: "session" };

  const token = bearer(req);
  if (token) {
    const tid = await resolveToken(token);
    if (tid) return { userId: tid, via: "token" };
  }

  return null;
}

/**
 * Resolve the current user id from a request, or null if unauthenticated.
 * Session cookie wins (web UI); otherwise a bearer token (AI/script).
 */
export async function getUserId(req: Request): Promise<string | null> {
  return (await getAuth(req))?.userId ?? null;
}

/** Like getAuth, but throws AuthError when there's no valid credential. */
export async function requireAuth(
  req: Request,
): Promise<{ userId: string; via: AuthVia }> {
  const auth = await getAuth(req);
  if (!auth) throw new AuthError("Sign in, or present a valid API token.");
  return auth;
}

/** Like getUserId, but throws AuthError when there's no valid credential. */
export async function requireUser(req: Request): Promise<string> {
  return (await requireAuth(req)).userId;
}
