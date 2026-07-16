/*
  ====================================================================
  USER + TOKEN SERVICE — accounts and the per-user API tokens that let
  a user connect their own Claude to their own tasks.
  ====================================================================
*/

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./client";
import { users, apiTokens, type UserRow } from "./schema";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  hashToken,
} from "@/lib/session";

/** Public view of a user — never includes the password hash. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
}

const toPublic = (u: UserRow): PublicUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
});

/* -------------------------------------------------------------------- */
/* Accounts                                                              */
/* -------------------------------------------------------------------- */

/** Create a user. Throws if the email is already taken. */
export async function createUser(
  email: string,
  name: string,
  password: string,
): Promise<PublicUser> {
  const normalized = email.trim().toLowerCase();
  const existing = await getUserByEmail(normalized);
  if (existing) throw new Error(`A user with email ${normalized} already exists`);
  const [row] = await db
    .insert(users)
    .values({ email: normalized, name, passwordHash: hashPassword(password) })
    .returning();
  return toPublic(row);
}

async function getRowByEmail(email: string): Promise<UserRow | undefined> {
  return (
    await db
      .select()
      .from(users)
      .where(eq(sql`lower(${users.email})`, email.trim().toLowerCase()))
      .limit(1)
  )[0];
}

export async function getUserByEmail(email: string): Promise<PublicUser | null> {
  const row = await getRowByEmail(email);
  return row ? toPublic(row) : null;
}

export async function getUserById(id: string): Promise<PublicUser | null> {
  const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
  return row ? toPublic(row) : null;
}

/** Verify email + password. Returns the user on success, null otherwise. */
export async function verifyLogin(
  email: string,
  password: string,
): Promise<PublicUser | null> {
  const row = await getRowByEmail(email);
  if (!row) return null;
  return verifyPassword(password, row.passwordHash) ? toPublic(row) : null;
}

/* -------------------------------------------------------------------- */
/* API tokens                                                            */
/* -------------------------------------------------------------------- */

export interface TokenInfo {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Metadata about a token (never the token itself). */
const tokenInfo = (r: {
  id: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}): TokenInfo => ({
  id: r.id,
  label: r.label,
  createdAt: r.createdAt.toISOString(),
  lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
});

export async function listTokens(userId: string): Promise<TokenInfo[]> {
  const rows = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(desc(apiTokens.createdAt));
  return rows.map(tokenInfo);
}

/** Create a token for a user. Returns the ONE-TIME plaintext + its metadata. */
export async function createToken(
  userId: string,
  label: string,
): Promise<{ plaintext: string; token: TokenInfo }> {
  const { plaintext, hash } = generateToken();
  const [row] = await db
    .insert(apiTokens)
    .values({ userId, tokenHash: hash, label: label || "Claude" })
    .returning();
  return { plaintext, token: tokenInfo(row) };
}

/** Revoke (delete) a token the user owns. Returns true if one was removed. */
export async function revokeToken(userId: string, tokenId: string): Promise<boolean> {
  const res = await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)))
    .returning();
  return res.length > 0;
}

/**
 * Resolve a plaintext bearer token to its owning user id, updating
 * lastUsedAt. Returns null if the token is unknown. This is how MCP /
 * REST requests from an AI get scoped to the right person's tasks.
 */
export async function resolveToken(plaintext: string): Promise<string | null> {
  const hash = hashToken(plaintext);
  const row = (
    await db
      .select({ id: apiTokens.id, userId: apiTokens.userId })
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hash))
      .limit(1)
  )[0];
  if (!row) return null;
  await db
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiTokens.id, row.id));
  return row.userId;
}
