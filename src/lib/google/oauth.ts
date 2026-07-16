/*
  ====================================================================
  GOOGLE OAUTH — the "Connect Google" flow, done with plain fetch.

  No SDK: the Authorization-Code + offline-refresh flow is a couple of
  form POSTs, so we call Google's endpoints directly and keep the bundle
  dependency-free (matching the rest of this app).

    connect  → buildAuthUrl()  → Google consent screen
    callback → exchangeCode()  → { access, refresh, expiry }
    later    → refreshAccessToken() mints fresh access tokens

  `state` is a signed (HMAC) blob carrying the scope + the user id, so the
  callback can trust which user + which kind of connection this is for
  without any server-side session store.
  ====================================================================
*/

import { createHmac, timingSafeEqual } from "node:crypto";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

/** Read/write events + read calendar list, plus basic identity for the email. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "openid",
  "email",
];

export type ConnectionScope = "shared" | "personal";

function clientCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set — add an OAuth client (see .env.example).",
    );
  }
  return { clientId, clientSecret };
}

/** The redirect URI Google calls back. Pinned by env, else derived from origin. */
export function redirectUri(origin: string): string {
  return process.env.GOOGLE_OAUTH_REDIRECT || `${origin}/api/google/callback`;
}

/* -------------------------------------------------------------------- */
/* Signed state (CSRF + carries scope/uid across the redirect)          */
/* -------------------------------------------------------------------- */

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function stateSecret(): string {
  return (
    process.env.SESSION_SECRET ??
    process.env.GOOGLE_TOKEN_ENC_KEY ??
    "dev-only-insecure-oauth-state-secret"
  );
}

export interface OAuthState {
  scope: ConnectionScope;
  uid: string;
  iat: number;
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

/** Sign a state blob for the consent redirect. */
export function signState(scope: ConnectionScope, uid: string, nowMs: number): string {
  const payload = b64(JSON.stringify({ scope, uid, iat: nowMs } satisfies OAuthState));
  const sig = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Verify + parse a state blob. Returns null if forged or expired. */
export function verifyState(value: string | undefined, nowMs: number): OAuthState | null {
  if (!value) return null;
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", stateSecret()).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as OAuthState;
    if (parsed.scope !== "shared" && parsed.scope !== "personal") return null;
    if (typeof parsed.uid !== "string" || typeof parsed.iat !== "number") return null;
    if (nowMs - parsed.iat > STATE_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- */
/* The flow                                                             */
/* -------------------------------------------------------------------- */

/** Build the Google consent URL to redirect the user to. */
export function buildAuthUrl(origin: string, state: string): string {
  const { clientId } = clientCreds();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline", // ask for a refresh token
    prompt: "consent", // force a refresh token even on re-consent
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
}

async function postToken(body: Record<string, string>): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google token endpoint failed (${res.status}): ${detail}`);
  }
  return res.json();
}

/** Exchange an authorization code for tokens (the callback step). */
export async function exchangeCode(code: string, origin: string): Promise<TokenSet> {
  const { clientId, clientSecret } = clientCreds();
  const t = await postToken({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(origin),
    grant_type: "authorization_code",
  });
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: new Date(Date.now() + t.expires_in * 1000),
  };
}

/** Mint a fresh access token from a stored refresh token. */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const { clientId, clientSecret } = clientCreds();
  const t = await postToken({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  return {
    accessToken: t.access_token,
    expiresAt: new Date(Date.now() + t.expires_in * 1000),
  };
}

/** Look up the connected account's email (for labeling the connection). */
export async function fetchUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return "";
  const info = (await res.json()) as { email?: string };
  return info.email ?? "";
}
