/*
  ====================================================================
  TELEGRAM WEBHOOK — the bot's front door. Telegram POSTs every DM here.

  Flow:
    1. Verify the request is really from Telegram (secret-token header).
    2. /start <code>  → bind this chat to the logged-in user (link flow).
    3. A linked chat's message → run the brain (Sonnet 5 + MCP connector),
       with a live status line driven by the model's tool calls.
    4. Confirm / Cancel button tap → run or drop the held destructive op.

  We ack Telegram immediately (200) and do the slow work in after(), so a
  multi-second turn never trips Telegram's retry (which would double-fire).

  Auth model: an UNLINKED chat gets nothing but the link prompt. A linked
  chat acts only as its own user, via that user's own MCP token — the same
  per-user scoping the MCP server already enforces for Claude Code.
  ====================================================================
*/

import { after } from "next/server";
import {
  resolveLink,
  linkChat,
  unlinkChat,
  consumeLinkCode,
  saveThread,
  setPendingConfirm,
  takePendingConfirm,
  type ThreadTurn,
} from "@/lib/db/telegram";
import { runBrain } from "@/lib/telegram/brain";
import { executeDestructive } from "@/lib/telegram/executor";
import {
  sendMessage,
  editMessageText,
  sendChatAction,
  answerCallbackQuery,
} from "@/lib/telegram/api";

export const runtime = "nodejs";
// Hobby plan hard-caps at 60s. Prompt caching (see brain.ts) keeps normal turns
// well under this; the guard below messages the user before the hard kill.
// On Vercel Pro this can go up to 300.
export const maxDuration = 60;

const CONFIRM = "td:confirm";
const CANCEL = "td:cancel";

// Message the user just before Vercel's hard kill, so a slow turn shows a clear
// note instead of a frozen "⏳ On it…". Kept under maxDuration so it always wins.
const TURN_BUDGET_MS = (maxDuration - 5) * 1000;
const TIMED_OUT = Symbol("timed_out");

/* Minimal shapes of the Telegram update payloads we consume. */
interface TgChat {
  id: number | string;
}
interface TgMessage {
  chat: TgChat;
  message_id: number;
  text?: string;
}
interface TgCallback {
  id: string;
  data?: string;
  message: TgMessage;
}
interface TgUpdate {
  message?: TgMessage;
  callback_query?: TgCallback;
}

export async function POST(req: Request): Promise<Response> {
  // 1. Only Telegram knows the secret we set on setWebhook.
  if (
    req.headers.get("x-telegram-bot-api-secret-token") !==
    process.env.TELEGRAM_WEBHOOK_SECRET
  ) {
    return new Response("forbidden", { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = (await req.json()) as TgUpdate;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Ack now; do the slow work after the response so Telegram doesn't retry.
  after(async () => {
    try {
      if (update.callback_query) await handleCallback(update.callback_query);
      else if (update.message?.text) await handleMessage(update.message);
    } catch (e) {
      console.error("[telegram] handler error", e);
    }
  });

  return new Response("ok");
}

/* -------------------------------------------------------------------- */
/* Messages                                                              */
/* -------------------------------------------------------------------- */

async function handleMessage(message: TgMessage): Promise<void> {
  const chatId = String(message.chat.id);
  const text = (message.text ?? "").trim();
  if (!text) return;

  if (text.startsWith("/start")) return handleStart(chatId, text);
  if (text === "/unlink") {
    const removed = await unlinkChat(chatId);
    await sendMessage(chatId, removed ? "Unlinked. 👋" : "This chat wasn't linked.");
    return;
  }
  if (text === "/help") {
    await sendMessage(
      chatId,
      "Ask me about your to-dos — e.g. _what's on today?_, _add a task to call the bank_, or _mark the onboarding task done_. /unlink disconnects this chat.",
    );
    return;
  }

  const link = await resolveLink(chatId);
  if (!link) {
    await sendMessage(
      chatId,
      "This chat isn't linked yet. Open *Settings → Connect Telegram* in the app to link it.",
    );
    return;
  }

  // Instant placeholder + keep the "typing…" bubble alive during the turn.
  await sendChatAction(chatId, "typing");
  const statusId = await sendMessage(chatId, "⏳ On it…");
  const keepTyping = setInterval(() => void sendChatAction(chatId, "typing"), 4000);

  // Tool-event-driven status (skip no-op edits to respect the edit rate limit).
  let lastStatus = "";
  const onStatus = (phrase: string) => {
    if (phrase === lastStatus || statusId == null) return;
    lastStatus = phrase;
    void editMessageText(chatId, statusId, phrase);
  };

  const thread: ThreadTurn[] = [...link.thread, { role: "user", content: text }];

  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      runBrain({
        mcpToken: link.mcpToken,
        thread: link.thread,
        userMessage: text,
        onStatus,
      }),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), TURN_BUDGET_MS);
      }),
    ]);
    clearTimeout(timer);

    // Ran out of time before Vercel kills the function — say so, don't freeze.
    if (result === TIMED_OUT) {
      if (statusId != null)
        await editMessageText(
          chatId,
          statusId,
          "⚠️ That took too long — try a narrower request.",
        );
      return;
    }

    // Token spend for this question, appended to the reply the user sees:
    // total plus the input / output / cache-read / cache-write breakdown.
    const u = result.usage;
    const n = (x: number) => x.toLocaleString();
    const tokenLine =
      `\n\n🪙 ${n(u.total)} tokens ` +
      `(${n(u.input)} in · ${n(u.output)} out · ${n(u.cacheRead)} cache read · ${n(u.cacheWrite)} cache write)`;

    if (result.proposal) {
      await setPendingConfirm(chatId, result.proposal);
      const body = `⚠️ ${result.proposal.summary}${tokenLine}`;
      if (statusId != null) {
        await editMessageText(chatId, statusId, body, {
          buttons: [
            { text: "✅ Confirm", callback_data: CONFIRM },
            { text: "✖️ Cancel", callback_data: CANCEL },
          ],
        });
      }
      thread.push({ role: "assistant", content: `(awaiting confirmation) ${result.proposal.summary}` });
    } else {
      const answer = result.text ?? "Done.";
      const shown = answer + tokenLine;
      if (statusId != null) await editMessageText(chatId, statusId, shown);
      else await sendMessage(chatId, shown);
      // Save the clean answer — keep the token line out of the model's context.
      thread.push({ role: "assistant", content: answer });
    }
    await saveThread(chatId, thread);
  } catch (e) {
    console.error("[telegram] brain error", e);
    if (statusId != null)
      await editMessageText(chatId, statusId, "⚠️ Something went wrong. Try again.");
  } finally {
    clearInterval(keepTyping);
  }
}

/** /start [<code>] — bind this chat to the user who generated the code. */
async function handleStart(chatId: string, text: string): Promise<void> {
  const code = text.replace(/^\/start/, "").trim();
  if (!code) {
    await sendMessage(
      chatId,
      "👋 To link this chat to your to-do board, open *Settings → Connect Telegram* in the app and tap the link there.",
    );
    return;
  }
  const userId = await consumeLinkCode(code);
  if (!userId) {
    await sendMessage(
      chatId,
      "That link is invalid or expired. Grab a fresh one from *Settings → Connect Telegram* in the app.",
    );
    return;
  }
  await linkChat(chatId, userId);
  await sendMessage(
    chatId,
    "✅ Linked! Ask me anything about your to-dos — e.g. _what's on today?_",
  );
}

/* -------------------------------------------------------------------- */
/* Button taps                                                           */
/* -------------------------------------------------------------------- */

async function handleCallback(cq: TgCallback): Promise<void> {
  const chatId = String(cq.message.chat.id);
  const messageId: number = cq.message.message_id;
  const data = cq.data ?? "";

  const link = await resolveLink(chatId);
  if (!link) {
    await answerCallbackQuery(cq.id, "This chat isn't linked.");
    return;
  }

  if (data === CANCEL) {
    await takePendingConfirm(chatId);
    await editMessageText(chatId, messageId, "✖️ Cancelled.");
    await answerCallbackQuery(cq.id, "Cancelled");
    return;
  }

  if (data === CONFIRM) {
    const pending = await takePendingConfirm(chatId);
    if (!pending) {
      await answerCallbackQuery(cq.id, "Nothing to confirm");
      await editMessageText(chatId, messageId, "This action already expired.");
      return;
    }
    try {
      const result = await executeDestructive(pending, link.userId);
      await editMessageText(chatId, messageId, result);
      await answerCallbackQuery(cq.id, "Done");
    } catch (e) {
      console.error("[telegram] execute error", e);
      await editMessageText(chatId, messageId, "⚠️ Couldn't complete that. Nothing was changed.");
      await answerCallbackQuery(cq.id, "Failed");
    }
    return;
  }

  await answerCallbackQuery(cq.id);
}
