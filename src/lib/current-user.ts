/*
  Server-Component helper: who is logged in, read from the session cookie
  via next/headers. Use this in server components / layouts (route handlers
  should use getUserId(req) from ./auth instead, since they hold a Request).
*/

import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession } from "./session";
import { getUserById, type PublicUser } from "./db/users";

/** The logged-in user, or null if there's no valid session. */
export async function currentUser(): Promise<PublicUser | null> {
  const store = await cookies();
  const uid = verifySession(store.get(SESSION_COOKIE)?.value, Date.now());
  if (!uid) return null;
  return getUserById(uid);
}
