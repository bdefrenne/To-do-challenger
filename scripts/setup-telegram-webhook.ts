/*
  Register (or refresh) the Telegram webhook so Telegram POSTs updates to
  our /api/telegram route, authenticated with the secret token.

  Usage:
    npm run telegram:webhook

  Requires in the environment (.env.local or Vercel):
    TELEGRAM_BOT_TOKEN      — from @BotFather
    TELEGRAM_WEBHOOK_SECRET — any random string (openssl rand -hex 32)
    APP_URL                 — deployed base URL, e.g. https://to-do-challenger.vercel.app

  Also prints the bot's @username — set that as TELEGRAM_BOT_USERNAME so the
  Connect page can build the t.me deep link.
*/

import { loadEnvConfig } from "@next/env";
loadEnvConfig(process.cwd(), true);

async function tg(method: string, body: Record<string, unknown>) {
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return res.json();
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const appUrl = process.env.APP_URL?.replace(/\/$/, "");
  const missing = [
    !token && "TELEGRAM_BOT_TOKEN",
    !secret && "TELEGRAM_WEBHOOK_SECRET",
    !appUrl && "APP_URL",
  ].filter(Boolean);
  if (missing.length) {
    console.error(`Missing env: ${missing.join(", ")}`);
    process.exit(1);
  }

  const me = await tg("getMe", {});
  if (!me.ok) {
    console.error("getMe failed — is TELEGRAM_BOT_TOKEN correct?", me.description);
    process.exit(1);
  }
  console.log(`Bot: @${me.result.username}`);
  console.log(`→ set TELEGRAM_BOT_USERNAME=${me.result.username}`);

  const set = await tg("setWebhook", {
    url: `${appUrl}/api/telegram`,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  if (!set.ok) {
    console.error("setWebhook failed:", set.description);
    process.exit(1);
  }
  console.log(`Webhook set → ${appUrl}/api/telegram`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
