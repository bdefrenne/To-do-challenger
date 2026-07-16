/*
  ====================================================================
  TELEGRAM BOT API — the thin HTTP client for talking back to Telegram.
  Just the handful of methods the bot needs: send/edit messages, the
  "typing…" indicator, inline Confirm/Cancel buttons, and callback acks.

  Markdown is best-effort: we try parse_mode "Markdown" and silently
  retry as plain text if Telegram rejects the entities (Claude's output
  occasionally has unbalanced * or _), so a formatting quirk never eats
  the message.
  ====================================================================
*/

const API = (method: string) =>
  `https://api.telegram.org/bot${botToken()}/${method}`;

function botToken(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set (get one from @BotFather).");
  return t;
}

/** One inline button. `data` rides back as a callback_query when tapped. */
export interface InlineButton {
  text: string;
  callback_data: string;
}

interface SendOpts {
  /** A single row of inline buttons (e.g. Confirm / Cancel). */
  buttons?: InlineButton[];
  /** Send as plain text, skipping the Markdown attempt. */
  plain?: boolean;
}

interface TgResponse {
  ok: boolean;
  description?: string;
  result?: { message_id: number };
}

async function call(method: string, body: Record<string, unknown>): Promise<TgResponse> {
  const res = await fetch(API(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<TgResponse>;
}

function replyMarkup(buttons?: InlineButton[]) {
  return buttons ? { inline_keyboard: [buttons.map((b) => ({ ...b }))] } : undefined;
}

/** Send a message. Returns the new message_id (for later edits), or null. */
export async function sendMessage(
  chatId: string | number,
  text: string,
  opts: SendOpts = {},
): Promise<number | null> {
  const base = { chat_id: chatId, text, reply_markup: replyMarkup(opts.buttons) };
  const first = opts.plain
    ? await call("sendMessage", base)
    : await call("sendMessage", { ...base, parse_mode: "Markdown" });
  if (first?.ok) return first.result?.message_id ?? null;
  // Retry as plain text if Markdown parsing was the problem.
  if (!opts.plain) {
    const retry = await call("sendMessage", base);
    if (retry?.ok) return retry.result?.message_id ?? null;
  }
  console.error("[telegram] sendMessage failed", first?.description);
  return null;
}

/** Overwrite an existing message (used for the live status line → answer). */
export async function editMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
  opts: SendOpts = {},
): Promise<void> {
  const base = {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: replyMarkup(opts.buttons),
  };
  const first = opts.plain
    ? await call("editMessageText", base)
    : await call("editMessageText", { ...base, parse_mode: "Markdown" });
  if (first?.ok) return;
  // "message is not modified" is benign; anything else, retry as plain text.
  if (!opts.plain && !String(first?.description).includes("not modified")) {
    await call("editMessageText", base);
  }
}

/** Show the "typing…" bubble (~5s). Re-send periodically during long turns. */
export async function sendChatAction(
  chatId: string | number,
  action = "typing",
): Promise<void> {
  await call("sendChatAction", { chat_id: chatId, action });
}

/** Acknowledge a button tap so Telegram stops the loading spinner. */
export async function answerCallbackQuery(id: string, text?: string): Promise<void> {
  await call("answerCallbackQuery", { callback_query_id: id, text });
}
