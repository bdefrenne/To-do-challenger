/*
  ====================================================================
  TELEGRAM LINK SERVICE — binds a Telegram DM to an app user and holds
  the per-user MCP token the bot uses to act AS that user.

  The bot is just a front door onto the SAME MCP server Claude Code uses
  (/api/mcp). At link time we mint a dedicated per-user API token, stash
  its plaintext encrypted (AES-GCM, GOOGLE_TOKEN_ENC_KEY), and hand it to
  the Anthropic MCP connector on every message. Unlinking revokes it.
  ====================================================================
*/

import { randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db } from "./client";
import {
  telegramLinks,
  telegramLinkCodes,
  type TelegramLinkRow,
} from "./schema";
import { createToken, revokeToken } from "./users";
import { encryptToken, decryptToken } from "@/lib/google/crypto";

/** How long a Connect-page link code is valid before the bot must be re-linked from. */
const CODE_TTL_MS = 15 * 60 * 1000;
/** Rolling context window: how many prior turns we keep for "add this to THAT task". */
const MAX_THREAD_TURNS = 10;
/** Idle gap after which we start a fresh conversation (drop stale "that task" context). */
const IDLE_RESET_MS = 8 * 60 * 60 * 1000;
/** A held destructive op is only honored if confirmed within this window. */
const PENDING_TTL_MS = 10 * 60 * 1000;

/** One turn of the rolling transcript. Content is plain text (Telegram). */
export interface ThreadTurn {
  role: "user" | "assistant";
  content: string;
}

/** A destructive op frozen until the user taps Confirm. */
export interface PendingConfirm {
  /** Human summary shown in the confirm prompt. */
  summary: string;
  /** The destructive tool call(s) to replay on approval. */
  calls: Array<{ tool: "delete_task" | "bulk_update" | "bulk_apply"; input: unknown }>;
  /** Epoch ms when proposed — a tap after PENDING_TTL_MS is rejected. */
  at?: number;
}

/** The bot's view of a linked chat — token already decrypted for use. */
export interface ResolvedLink {
  chatId: string;
  userId: string;
  mcpToken: string;
  thread: ThreadTurn[];
  pendingConfirm: PendingConfirm | null;
}

/* -------------------------------------------------------------------- */
/* Link codes — the Connect-page → `/start <code>` handshake            */
/* -------------------------------------------------------------------- */

/** Seed a one-time code for the logged-in user; returns the deep-link payload. */
export async function issueLinkCode(userId: string): Promise<string> {
  const code = randomBytes(16).toString("hex"); // 32 chars — fits Telegram's 64-char start param
  await db.insert(telegramLinkCodes).values({
    code,
    userId,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return code;
}

/** Consume a code (single-use). Returns the userId, or null if unknown/expired. */
export async function consumeLinkCode(code: string): Promise<string | null> {
  const row = (
    await db
      .select()
      .from(telegramLinkCodes)
      .where(eq(telegramLinkCodes.code, code))
      .limit(1)
  )[0];
  // Consume unconditionally so a leaked code can't be retried.
  if (row) {
    await db.delete(telegramLinkCodes).where(eq(telegramLinkCodes.code, code));
  }
  // Lazy sweep of anything else that's expired.
  await db.delete(telegramLinkCodes).where(lt(telegramLinkCodes.expiresAt, new Date()));
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return row.userId;
}

/* -------------------------------------------------------------------- */
/* Links                                                                 */
/* -------------------------------------------------------------------- */

/**
 * Bind (or re-bind) a chat to a user: mint a fresh MCP token, encrypt it,
 * and store the link. Re-linking revokes the previous token first so a
 * stale one never lingers.
 */
export async function linkChat(chatId: string, userId: string): Promise<void> {
  const existing = await getRawLink(chatId);
  if (existing) {
    await revokeToken(existing.userId, existing.mcpTokenId).catch(() => {});
    await db.delete(telegramLinks).where(eq(telegramLinks.chatId, chatId));
  }
  const { plaintext, token } = await createToken(userId, "Telegram");
  await db.insert(telegramLinks).values({
    chatId,
    userId,
    mcpTokenEnc: encryptToken(plaintext),
    mcpTokenId: token.id,
    thread: [],
    pendingConfirm: null,
    lastSeenAt: new Date(),
  });
}

/** Remove a chat's link and revoke its MCP token. Returns true if one existed. */
export async function unlinkChat(chatId: string): Promise<boolean> {
  const existing = await getRawLink(chatId);
  if (!existing) return false;
  await revokeToken(existing.userId, existing.mcpTokenId).catch(() => {});
  await db.delete(telegramLinks).where(eq(telegramLinks.chatId, chatId));
  return true;
}

async function getRawLink(chatId: string): Promise<TelegramLinkRow | undefined> {
  return (
    await db
      .select()
      .from(telegramLinks)
      .where(eq(telegramLinks.chatId, chatId))
      .limit(1)
  )[0];
}

/**
 * Resolve a chat to its user + decrypted MCP token + context, bumping
 * lastSeenAt. Returns null for an unlinked chat — the webhook treats that
 * as "not authorized, run the link prompt".
 */
export async function resolveLink(chatId: string): Promise<ResolvedLink | null> {
  const row = await getRawLink(chatId);
  if (!row) return null;

  // Idle too long → start fresh: drop the stale transcript and any held op so
  // a conversation resumed days later doesn't carry "that task" references.
  const idle = row.lastSeenAt
    ? Date.now() - row.lastSeenAt.getTime() > IDLE_RESET_MS
    : false;

  const set: Record<string, unknown> = { lastSeenAt: new Date() };
  if (idle) {
    set.thread = [];
    set.pendingConfirm = null;
  }
  await db.update(telegramLinks).set(set).where(eq(telegramLinks.chatId, chatId));

  return {
    chatId: row.chatId,
    userId: row.userId,
    mcpToken: decryptToken(row.mcpTokenEnc),
    thread: idle ? [] : (row.thread as ThreadTurn[]) ?? [],
    pendingConfirm: idle ? null : (row.pendingConfirm as PendingConfirm | null) ?? null,
  };
}

/** Persist the rolling transcript, trimmed to the last MAX_THREAD_TURNS. */
export async function saveThread(chatId: string, thread: ThreadTurn[]): Promise<void> {
  await db
    .update(telegramLinks)
    .set({ thread: thread.slice(-MAX_THREAD_TURNS) })
    .where(eq(telegramLinks.chatId, chatId));
}

/** Freeze a destructive op awaiting a Confirm tap. */
export async function setPendingConfirm(
  chatId: string,
  pending: PendingConfirm,
): Promise<void> {
  await db
    .update(telegramLinks)
    .set({ pendingConfirm: { ...pending, at: Date.now() } })
    .where(eq(telegramLinks.chatId, chatId));
}

/**
 * Clear (and return) a held op — after a Confirm or Cancel tap. Returns null
 * if it was already gone OR older than PENDING_TTL_MS (a stale tap never
 * executes a days-old delete). Always clears the row.
 */
export async function takePendingConfirm(
  chatId: string,
): Promise<PendingConfirm | null> {
  const row = await getRawLink(chatId);
  const pending = (row?.pendingConfirm as PendingConfirm | null) ?? null;
  if (pending) {
    await db
      .update(telegramLinks)
      .set({ pendingConfirm: null })
      .where(and(eq(telegramLinks.chatId, chatId)));
  }
  if (!pending) return null;
  if (pending.at && Date.now() - pending.at > PENDING_TTL_MS) return null;
  return pending;
}
