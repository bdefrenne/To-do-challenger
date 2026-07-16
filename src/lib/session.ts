/*
  ====================================================================
  CRYPTO PRIMITIVES — passwords, session cookies, API tokens.
  All self-contained (Node's built-in crypto); no external auth service.

    • Passwords  — scrypt, salted, constant-time compare.
    • Sessions   — a signed (HMAC-SHA256) cookie carrying the user id.
                   Stateless: no sessions table, revoke by rotating the
                   secret or changing the password... (kept simple on
                   purpose for a light personal tool).
    • API tokens — random secret shown once; only its SHA-256 hash is
                   stored, so the DB never holds anything usable.
  ====================================================================
*/

import {
  scryptSync,
  randomBytes,
  createHmac,
  createHash,
  timingSafeEqual,
} from "node:crypto";

/* ---- Secret ----
   HMAC key for session cookies. Required in production; a fixed dev
   fallback keeps localhost frictionless (with a warning). */
function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET is not set. Generate one: openssl rand -hex 32");
  }
  return "dev-only-insecure-session-secret-change-me";
}

/* -------------------------------------------------------------------- */
/* Passwords (scrypt)                                                    */
/* -------------------------------------------------------------------- */

/** Hash a password for storage. Returns `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Verify a password against a stored `scrypt$salt$hash` string. */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* -------------------------------------------------------------------- */
/* Session cookies (signed, stateless)                                   */
/* -------------------------------------------------------------------- */

export const SESSION_COOKIE = "todo_session";
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

const b64url = (b: Buffer) => b.toString("base64url");

/** Create a signed cookie value carrying the user id + issued-at. */
export function signSession(userId: string, nowMs: number): string {
  const payload = b64url(Buffer.from(JSON.stringify({ uid: userId, iat: nowMs })));
  const sig = b64url(
    createHmac("sha256", sessionSecret()).update(payload).digest(),
  );
  return `${payload}.${sig}`;
}

/**
 * Verify a session cookie value. Returns the user id, or null if the
 * signature is bad or the session is older than SESSION_MAX_AGE_S.
 * `nowMs` is passed in so callers control the clock (and tests can too).
 */
export function verifySession(value: string | undefined, nowMs: number): string | null {
  if (!value) return null;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;

  const expected = createHmac("sha256", sessionSecret()).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  try {
    const { uid, iat } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof uid !== "string" || typeof iat !== "number") return null;
    if (nowMs - iat > SESSION_MAX_AGE_S * 1000) return null;
    return uid;
  } catch {
    return null;
  }
}

/** Cookie attributes for setting/clearing the session. */
export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE_S,
  };
}

/* -------------------------------------------------------------------- */
/* API tokens                                                            */
/* -------------------------------------------------------------------- */

/** SHA-256 hex of a token's plaintext — what we store + look up by. */
export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Mint a fresh token. Returns the one-time plaintext and its stored hash. */
export function generateToken(): { plaintext: string; hash: string } {
  const plaintext = `todo_${randomBytes(24).toString("hex")}`;
  return { plaintext, hash: hashToken(plaintext) };
}
