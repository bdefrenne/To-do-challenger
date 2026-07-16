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

/**
 * Resolve the current user id from a request, or null if unauthenticated.
 * Session cookie wins (web UI); otherwise a bearer token (AI/script).
 */
export async function getUserId(req: Request): Promise<string | null> {
  const cookie = readCookie(req, SESSION_COOKIE);
  const uid = verifySession(cookie, Date.now());
  if (uid) return uid;

  const token = bearer(req);
  if (token) return await resolveToken(token);

  return null;
}

/** Like getUserId, but throws AuthError when there's no valid credential. */
export async function requireUser(req: Request): Promise<string> {
  const uid = await getUserId(req);
  if (!uid) throw new AuthError("Sign in, or present a valid API token.");
  return uid;
}
