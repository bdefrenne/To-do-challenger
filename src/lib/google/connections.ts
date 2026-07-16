/*
  ====================================================================
  GOOGLE CONNECTIONS — the persisted OAuth connections that back the
  calendar. Every connection (the one shared + every user's personal) is
  team-visible: listConnections() returns them ALL, regardless of caller.

  This module owns the DB row + turning a stored refresh token into a
  live access token (refreshing + caching it back on the row when stale).
  Event reads/writes live in ./calendar.ts.
  ====================================================================
*/

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  googleConnections,
  users,
  type GoogleConnectionRow,
} from "../db/schema";
import { encryptToken, decryptToken } from "./crypto";
import { refreshAccessToken, type ConnectionScope, type TokenSet } from "./oauth";

/** The semantic types a calendar can have (mirrors the DB enum). */
export type CalendarType = "standard" | "holidays";

/** Every non-`standard` type is a tag `resolveTarget` accepts as a write target. */
export const CALENDAR_TYPE_TAGS: readonly CalendarType[] = ["holidays"];

/** A calendar connection as the UI/API sees it — never includes secrets. */
export interface PublicConnection {
  id: string;
  scope: ConnectionScope;
  type: CalendarType;
  ownerName: string;
  googleEmail: string;
  calendarId: string;
  color: string;
  label: string;
  /** True when this connection belongs to the caller (set per-request). */
  mine: boolean;
}

/** Palette for personal calendars (shared uses the brand accent). */
const SHARED_COLOR = "#7b68ee";
const PERSONAL_COLORS = [
  "#4f8bff",
  "#22a06b",
  "#e08a1e",
  "#e93d82",
  "#e5484d",
  "#0ea5b7",
  "#8b5cf6",
];

const toPublic = (
  r: GoogleConnectionRow,
  currentUserId?: string,
): PublicConnection => ({
  id: r.id,
  scope: r.scope,
  type: r.type,
  ownerName: r.label,
  googleEmail: r.googleEmail,
  calendarId: r.calendarId,
  color: r.color,
  label: r.label,
  mine: r.userId === currentUserId,
});

/** Every connection on the instance (shared + all personal), shared first. */
export async function listConnections(): Promise<GoogleConnectionRow[]> {
  return db
    .select()
    .from(googleConnections)
    .orderBy(asc(googleConnections.scope), asc(googleConnections.createdAt));
}

/** Public (secret-free) roster for the settings UI, legend, and pickers.
 *  Pass the caller's id to flag which connections are theirs (`mine`). */
export async function listPublicConnections(
  currentUserId?: string,
): Promise<PublicConnection[]> {
  return (await listConnections()).map((r) => toPublic(r, currentUserId));
}

export async function getConnectionById(
  id: string,
): Promise<GoogleConnectionRow | undefined> {
  return (
    await db
      .select()
      .from(googleConnections)
      .where(eq(googleConnections.id, id))
      .limit(1)
  )[0];
}

export async function getSharedConnection(): Promise<GoogleConnectionRow | undefined> {
  return (
    await db
      .select()
      .from(googleConnections)
      .where(eq(googleConnections.scope, "shared"))
      .limit(1)
  )[0];
}

/** The (first) connection of a given type — e.g. the "holidays" calendar. */
export async function getConnectionByType(
  type: CalendarType,
): Promise<GoogleConnectionRow | undefined> {
  return (
    await db
      .select()
      .from(googleConnections)
      .where(eq(googleConnections.type, type))
      .orderBy(asc(googleConnections.createdAt))
      .limit(1)
  )[0];
}

/**
 * Resolve a create/write target to a connection:
 *   • `undefined` / `"shared"` → the shared connection.
 *   • a type tag (e.g. `"holidays"`) → the calendar of that type. This is how
 *     code addresses a special calendar without knowing its connection id.
 *   • anything else → a connection id.
 */
export async function resolveTarget(
  target: string | undefined,
): Promise<GoogleConnectionRow | undefined> {
  if (!target || target === "shared") return getSharedConnection();
  const tag = target.toLowerCase() as CalendarType;
  if (CALENDAR_TYPE_TAGS.includes(tag)) return getConnectionByType(tag);
  return getConnectionById(target);
}

/**
 * Store (or replace) a connection after a successful OAuth exchange.
 * `shared` upserts the singleton row; `personal` upserts the caller's row.
 */
export async function saveConnection(opts: {
  scope: ConnectionScope;
  userId: string;
  googleEmail: string;
  tokens: TokenSet;
}): Promise<GoogleConnectionRow> {
  const { scope, userId, googleEmail, tokens } = opts;

  const owner = (
    await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1)
  )[0];

  // Existing row of this kind? (one shared; one personal per user)
  const existing =
    scope === "shared"
      ? await getSharedConnection()
      : (
          await db
            .select()
            .from(googleConnections)
            .where(
              and(
                eq(googleConnections.scope, "personal"),
                eq(googleConnections.userId, userId),
              ),
            )
            .limit(1)
        )[0];

  // Keep a name the user set earlier; otherwise default it (shared → "Shared",
  // personal → the owner's name). So a rename survives a re-connect.
  const label =
    existing?.label ?? (scope === "shared" ? "Shared" : owner?.name || googleEmail);

  const color =
    existing?.color ??
    (scope === "shared" ? SHARED_COLOR : await nextPersonalColor());

  // Google only returns a refresh token on first consent; if we're
  // re-connecting and didn't get one, keep the previously stored one.
  const refreshTokenEnc = tokens.refreshToken
    ? encryptToken(tokens.refreshToken)
    : existing?.refreshTokenEnc;
  if (!refreshTokenEnc) {
    throw new Error(
      "Google did not return a refresh token. Remove this app's access at " +
        "myaccount.google.com/permissions and connect again.",
    );
  }

  const values = {
    scope,
    userId,
    googleEmail,
    refreshTokenEnc,
    accessToken: tokens.accessToken,
    accessTokenExpiry: tokens.expiresAt,
    color,
    label,
    updatedAt: new Date(),
  };

  if (existing) {
    const [row] = await db
      .update(googleConnections)
      .set(values)
      .where(eq(googleConnections.id, existing.id))
      .returning();
    return row;
  }
  const [row] = await db.insert(googleConnections).values(values).returning();
  return row;
}

/** Pick the next unused color from the palette (falls back to cycling). */
async function nextPersonalColor(): Promise<string> {
  const used = new Set(
    (await listConnections())
      .filter((c) => c.scope === "personal")
      .map((c) => c.color),
  );
  return PERSONAL_COLORS.find((c) => !used.has(c)) ?? PERSONAL_COLORS[used.size % PERSONAL_COLORS.length];
}

/** Change which calendar a connection reads/writes. */
export async function setCalendarId(id: string, calendarId: string): Promise<void> {
  await db
    .update(googleConnections)
    .set({ calendarId, updatedAt: new Date() })
    .where(eq(googleConnections.id, id));
}

/** Change a connection's semantic type (standard/holidays). */
export async function setConnectionType(
  id: string,
  type: CalendarType,
): Promise<void> {
  await db
    .update(googleConnections)
    .set({ type, updatedAt: new Date() })
    .where(eq(googleConnections.id, id));
}

/** Rename a connection (the label shown in the legend + as an event's owner). */
export async function setConnectionLabel(id: string, label: string): Promise<void> {
  await db
    .update(googleConnections)
    .set({ label, updatedAt: new Date() })
    .where(eq(googleConnections.id, id));
}

export async function deleteConnection(id: string): Promise<boolean> {
  const res = await db
    .delete(googleConnections)
    .where(eq(googleConnections.id, id))
    .returning({ id: googleConnections.id });
  return res.length > 0;
}

/**
 * Return a valid access token for a connection, refreshing (and caching the
 * new token back on the row) when the cached one is missing or near expiry.
 */
export async function accessTokenFor(conn: GoogleConnectionRow): Promise<string> {
  const skewMs = 60_000; // refresh a minute early to avoid edge expiries
  const stillValid =
    conn.accessToken &&
    conn.accessTokenExpiry &&
    conn.accessTokenExpiry.getTime() - skewMs > Date.now();
  if (stillValid) return conn.accessToken!;

  const refreshToken = decryptToken(conn.refreshTokenEnc);
  const { accessToken, expiresAt } = await refreshAccessToken(refreshToken);
  // Best-effort cache; a failed write just means we refresh again next time.
  try {
    await db
      .update(googleConnections)
      .set({ accessToken, accessTokenExpiry: expiresAt })
      .where(eq(googleConnections.id, conn.id));
  } catch {
    /* non-fatal */
  }
  return accessToken;
}

/** True if any connection exists (used to short-circuit empty instances). */
export async function hasAnyConnection(): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(googleConnections);
  return Number(rows[0]?.n ?? 0) > 0;
}
